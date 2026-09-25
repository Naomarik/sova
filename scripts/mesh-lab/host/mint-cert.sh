#!/bin/sh
# Lab CA + certificates, run by `lab` inside the lab image with STATE/tls mounted at /tls.
#   mint-cert.sh                      ensure the CA exists
#   mint-cert.sh <stem> <dns-name>…   also mint <stem>.pem / <stem>-key.pem for those names
set -e
cd /tls
umask 077
if [ ! -s ca.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
    -subj "/CN=Sova mesh lab CA" -keyout ca-key.pem -out ca.pem 2>/dev/null
  chmod 0644 ca.pem
fi
[ $# -ge 2 ] || exit 0
stem=$1; shift
[ -s "$stem.pem" ] && exit 0
san=$(printf 'DNS:%s,' "$@"); san=${san%,}
openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$1" \
  -keyout "$stem-key.pem" -out "$stem.csr" 2>/dev/null
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\n' "$san" > "$stem.ext"
openssl x509 -req -in "$stem.csr" -CA ca.pem -CAkey ca-key.pem -CAcreateserial -days 3650 \
  -extfile "$stem.ext" -out "$stem.pem" 2>/dev/null
rm -f "$stem.csr" "$stem.ext"
chmod 0644 "$stem.pem"
