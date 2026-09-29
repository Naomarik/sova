// sova-transcribe-host: transcribe.cpp (libtranscribe, its prebuilt release) behind the two HTTP
// routes Sova's voice runtime already speaks to whisper-server (§chat.voice/runtime), so one
// supervisor runs either engine: GET /health, and POST /inference with a raw 16 kHz mono 16-bit
// WAV body, answering {"text": "..."}. The release ships only the library, and Node has no
// built-in FFI, so voice setup compiles this file with `cc` against the pinned header.
//
//   sova-transcribe-host --host H --port P -m MODEL.gguf [-t N] [--no-gpu] [--inference-path /inference]
//
// One request at a time, one connection at a time: the runtime already serializes requests.

#define _GNU_SOURCE
#include "transcribe.h"

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define MAX_BODY (16 * 1024 * 1024)
#define MAX_HEAD 16384

static void on_term(int sig) {
    (void) sig;
    _exit(0);
}

static int write_all(int fd, const char * buf, size_t n) {
    while (n > 0) {
        ssize_t w = write(fd, buf, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        buf += w;
        n -= (size_t) w;
    }
    return 0;
}

static void respond(int fd, int status, const char * reason, const char * json) {
    char head[256];
    int  n = snprintf(head, sizeof head,
                      "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
                      status, reason, strlen(json));
    write_all(fd, head, (size_t) n);
    write_all(fd, json, strlen(json));
}

/* A JSON string body for `text`: quotes, backslashes and control characters escaped. */
static char * json_text(const char * key, const char * text) {
    size_t len = strlen(text);
    char * out = malloc(len * 6 + strlen(key) + 16);
    if (!out) return NULL;
    char * p = out;
    p += sprintf(p, "{\"%s\":\"", key);
    for (const unsigned char * s = (const unsigned char *) text; *s; s++) {
        if (*s == '"' || *s == '\\') {
            *p++ = '\\';
            *p++ = (char) *s;
        } else if (*s == '\n') {
            *p++ = '\\';
            *p++ = 'n';
        } else if (*s < 0x20) {
            p += sprintf(p, "\\u%04x", *s);
        } else {
            *p++ = (char) *s;
        }
    }
    strcpy(p, "\"}");
    return out;
}

static uint32_t le32(const unsigned char * b) { return (uint32_t) b[0] | (uint32_t) b[1] << 8 | (uint32_t) b[2] << 16 | (uint32_t) b[3] << 24; }
static uint16_t le16(const unsigned char * b) { return (uint16_t) (b[0] | b[1] << 8); }

/* 16 kHz mono 16-bit PCM WAV → float samples, or NULL with *why set. */
static float * wav_samples(const unsigned char * b, size_t n, int * out_n, const char ** why) {
    if (n < 44 || memcmp(b, "RIFF", 4) != 0 || memcmp(b + 8, "WAVE", 4) != 0) {
        *why = "not a RIFF/WAVE body";
        return NULL;
    }
    size_t off = 12;
    int    fmt_ok = 0;
    while (off + 8 <= n) {
        uint32_t size = le32(b + off + 4);
        size_t   body = off + 8;
        if (memcmp(b + off, "fmt ", 4) == 0) {
            if (body + 16 > n) break;
            if (le16(b + body) != 1 || le16(b + body + 2) != 1 || le32(b + body + 4) != 16000 || le16(b + body + 14) != 16) {
                *why = "the WAV must be 16 kHz mono 16-bit PCM";
                return NULL;
            }
            fmt_ok = 1;
        } else if (memcmp(b + off, "data", 4) == 0) {
            if (!fmt_ok) break;
            size_t bytes = size < n - body ? size : n - body;
            int    count = (int) (bytes / 2);
            if (count <= 0) {
                *why = "the WAV holds no samples";
                return NULL;
            }
            float * pcm = malloc((size_t) count * sizeof(float));
            if (!pcm) {
                *why = "out of memory";
                return NULL;
            }
            for (int i = 0; i < count; i++) pcm[i] = (float) (int16_t) le16(b + body + (size_t) i * 2) / 32768.0f;
            *out_n = count;
            return pcm;
        }
        off = body + size + (size & 1);
    }
    *why = "the WAV has no fmt and data chunks";
    return NULL;
}

/* The abort callback: the client hung up (the runtime's timeout, or Sova stopping), so the run
   stops between decode steps instead of holding the model. */
static bool client_gone(void * user_data) {
    int           fd = *(int *) user_data;
    struct pollfd p = { .fd = fd, .events = POLLIN | POLLRDHUP };
    if (poll(&p, 1, 0) <= 0) return false;
    if (p.revents & (POLLHUP | POLLRDHUP | POLLERR)) return true;
    char c;
    return recv(fd, &c, 1, MSG_PEEK | MSG_DONTWAIT) == 0;
}

static void serve(int fd, struct transcribe_session * session, const char * inference_path) {
    char   head[MAX_HEAD + 1];
    size_t got = 0;
    char * end = NULL;
    while (!end) {
        if (got >= MAX_HEAD) return;
        ssize_t r = read(fd, head + got, MAX_HEAD - got);
        if (r <= 0) return;
        got += (size_t) r;
        head[got] = 0;
        end = strstr(head, "\r\n\r\n");
    }
    size_t head_len = (size_t) (end - head) + 4;
    char   method[8] = { 0 }, path[256] = { 0 };
    if (sscanf(head, "%7s %255s", method, path) != 2) return;
    char * q = strchr(path, '?');
    if (q) *q = 0;
    if (strcmp(method, "GET") == 0 && strcmp(path, "/health") == 0) {
        respond(fd, 200, "OK", "{\"status\":\"ok\"}");
        return;
    }
    if (strcmp(method, "POST") != 0 || strcmp(path, inference_path) != 0) {
        respond(fd, 404, "Not Found", "{\"error\":\"not found\"}");
        return;
    }
    size_t length = 0;
    for (char * line = strstr(head, "\r\n"); line && line < end; line = strstr(line + 2, "\r\n")) {
        if (strncasecmp(line + 2, "content-length:", 15) == 0) length = strtoul(line + 17, NULL, 10);
    }
    if (length == 0 || length > MAX_BODY) {
        respond(fd, 400, "Bad Request", "{\"error\":\"a WAV body with a Content-Length is required\"}");
        return;
    }
    unsigned char * body = malloc(length);
    if (!body) {
        respond(fd, 500, "Internal Server Error", "{\"error\":\"out of memory\"}");
        return;
    }
    size_t have = got - head_len < length ? got - head_len : length;
    memcpy(body, head + head_len, have);
    while (have < length) {
        ssize_t r = read(fd, body + have, length - have);
        if (r <= 0) {
            free(body);
            return;
        }
        have += (size_t) r;
    }
    const char * why = NULL;
    int          n = 0;
    float *      pcm = wav_samples(body, length, &n, &why);
    free(body);
    if (!pcm) {
        char * msg = json_text("error", why);
        respond(fd, 400, "Bad Request", msg ? msg : "{\"error\":\"bad WAV\"}");
        free(msg);
        return;
    }
    transcribe_set_abort_callback(session, client_gone, &fd);
    transcribe_status st = transcribe_run(session, pcm, n, NULL);
    transcribe_set_abort_callback(session, NULL, NULL);
    free(pcm);
    if (st != TRANSCRIBE_OK) {
        char * msg = json_text("error", transcribe_status_string(st));
        respond(fd, 500, "Internal Server Error", msg ? msg : "{\"error\":\"failed\"}");
        free(msg);
        // A backend failure leaves the session unusable: exit, and the runtime's crash handling
        // starts a fresh process (and gives up after 3 in a minute).
        if (st == TRANSCRIBE_ERR_BACKEND) {
            fprintf(stderr, "error: transcribe_run: %s; exiting\n", transcribe_status_string(st));
            close(fd);
            exit(1);
        }
        return;
    }
    const char * text = transcribe_full_text(session);
    char *       msg = json_text("text", text ? text : "");
    respond(fd, 200, "OK", msg ? msg : "{\"text\":\"\"}");
    free(msg);
}

int main(int argc, char ** argv) {
    const char * host = "127.0.0.1";
    const char * model = NULL;
    const char * inference_path = "/inference";
    int          port = 8080, threads = 0, cpu = 0;
    for (int i = 1; i < argc; i++) {
        const char * a = argv[i];
        const char * v = i + 1 < argc ? argv[i + 1] : NULL;
        if (strcmp(a, "--help") == 0 || strcmp(a, "-h") == 0) {
            printf("usage: %s --host H --port P -m MODEL.gguf [-t N] [--no-gpu] [--inference-path PATH]\n", argv[0]);
            return 0;
        } else if (strcmp(a, "--no-gpu") == 0) {
            cpu = 1;
        } else if (v && strcmp(a, "--host") == 0) {
            host = v, i++;
        } else if (v && strcmp(a, "--port") == 0) {
            port = atoi(v), i++;
        } else if (v && strcmp(a, "-m") == 0) {
            model = v, i++;
        } else if (v && strcmp(a, "-t") == 0) {
            threads = atoi(v), i++;
        } else if (v && strcmp(a, "--inference-path") == 0) {
            inference_path = v, i++;
        } else {
            fprintf(stderr, "unknown argument: %s\n", a);
            return 2;
        }
    }
    if (!model) {
        fprintf(stderr, "error: -m MODEL is required\n");
        return 2;
    }
    signal(SIGTERM, on_term);
    signal(SIGPIPE, SIG_IGN);
    setvbuf(stderr, NULL, _IONBF, 0);

    transcribe_init_backends_default();
    struct transcribe_model_load_params lp;
    transcribe_model_load_params_init(&lp);
    lp.backend = cpu ? TRANSCRIBE_BACKEND_CPU : TRANSCRIBE_BACKEND_AUTO;
    struct transcribe_session_params sp;
    transcribe_session_params_init(&sp);
    sp.n_threads = threads;
    struct transcribe_session * session = NULL;
    transcribe_status           st = transcribe_open(model, &lp, &sp, &session);
    if (st != TRANSCRIBE_OK) {
        fprintf(stderr, "error: transcribe_open(%s): %s\n", model, transcribe_status_string(st));
        return 1;
    }
    const char * backend = transcribe_model_backend(transcribe_get_model(session));
    int          gpu = backend && strcmp(backend, "cpu") != 0 && strcmp(backend, "CPU") != 0;
    // The same "use gpu" line whisper-server prints, which the runtime's log check reads.
    fprintf(stderr, "sova-transcribe-host: backend %s, use gpu = %d\n", backend ? backend : "unknown", gpu);

    int srv = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t) port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1 || bind(srv, (struct sockaddr *) &addr, sizeof addr) != 0 || listen(srv, 8) != 0) {
        fprintf(stderr, "error: can't listen on %s:%d: %s\n", host, port, strerror(errno));
        return 1;
    }
    fprintf(stderr, "sova-transcribe-host listening at http://%s:%d\n", host, port);
    for (;;) {
        int fd = accept(srv, NULL, NULL);
        if (fd < 0) {
            if (errno == EINTR) continue;
            return 1;
        }
        serve(fd, session, inference_path);
        close(fd);
    }
}
