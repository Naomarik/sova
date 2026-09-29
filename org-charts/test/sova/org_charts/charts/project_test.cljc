(ns sova.org-charts.charts.project-test
  "The project chart against server/project-overseer.ts: noteReason/withReason, watchDecision's
   gates, lookNow (Run Now, skips, held looks), how a run ends, held items and their release, and
   the item → project reasons."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [clojure.string :as str]
    [sova.org-charts.charts.common :as c]
    [sova.org-charts.charts.guards :as g]
    [sova.org-charts.charts.harness :as h]
    [sova.org-charts.charts.project :as p]
    [sova.org-charts.charts.reasons :as r]))

(def min-ms 60000)

(defn host
  ([] (host {}))
  ([data]
   (let [x (h/new-host)]
     (h/start! x :project "p" (merge {:project-sid "p" :roster-active true} data)))))

(defn watch-state [x] (some #(when (h/in? x "p" %) %) [:quiet :waiting :due :held :running]))
(defn reasons [x] (mapv :text (:reasons (h/data x "p"))))
(defn last-run [x] (:last-run (h/data x "p")))
(defn looks [x] @(:started (:look x)))

(def done-reason {:kind "baton/done" :params {:title "Invoicing"}})
(def closed-reason {:kind "baton/closed" :params {:title "Invoicing"}})

(deftest reason-sentences-are-todays
  (is (= "The gathering session \"A\" reached its goal." (r/text {:kind "baton/done" :params {:title "A"}})))
  (is (= "The gathering session \"A\" was closed." (r/text {:kind "baton/closed" :params {:title "A"}})))
  (is (= "Someone was referred in \"A\" (a proposed roster person)." (r/text {:kind "baton/proposal" :params {:title "A"}})))
  (is (= "The gathering session \"A\" handed a question to the operator (their words, as data): \"Why?\""
        (r/text {:kind "baton/asked-operator" :params {:title "A" :question "Why?"}})))
  (is (= "1 new conflict between decisions." (r/text {:kind "reconcile/conflict" :params {:n 1}})))
  (is (= "2 new conflicts between decisions." (r/text {:kind "reconcile/conflict" :params {:n 2}})))
  (is (= "1 conflict was resolved." (r/text {:kind "reconcile/resolved" :params {:n 1}})))
  (is (= "3 conflicts were resolved." (r/text {:kind "reconcile/resolved" :params {:n 3}})))
  (is (= "The operator promoted 2 decisions into the spec." (r/text {:kind "reconcile/promoted" :params {:n 2 :by "operator-explicit"}})))
  (is (= "1 decision was promoted into the spec." (r/text {:kind "reconcile/promoted" :params {:n 1 :by "overseer"}})))
  (is (= "0 decisions were promoted into the spec." (r/text {:kind "reconcile/promoted" :params {:n 0 :by "operator-bulk"}})))
  (is (= "1 decision is drafted and promotable." (r/text {:kind "reconcile/drafted" :params {:n 1}})))
  (is (= "4 decisions are drafted and promotable." (r/text {:kind "reconcile/drafted" :params {:ids ["a" "b" "c" "d"]}})))
  (is (= "The coding session \"B\" finished its turn." (r/text {:kind "coding/settled" :params {:title "B"}})))
  (is (= "The coding session \"B\" stopped with an error." (r/text {:kind "coding/settled" :params {:title "B" :failed true}})))
  (is (= "The operator merged \"B\" (sova/b) into main." (r/text {:kind "build/merged" :params {:title "B" :branch "sova/b" :target "main"}})))
  (is (= "Merge Branch for \"B\" was refused: It has uncommitted changes." (r/text {:kind "build/merge-refused" :params {:title "B" :reason "It has uncommitted changes."}})))
  (is (= "The operator's last message reached its limit on decisions promoted; it may go on within today's allowance."
        (r/text {:kind "held/message" :params {:what "decisions promoted"}})))
  (is (= "You raised the limit on looks." (r/text {:kind "held/raised" :params {:what "looks"}}))))

(deftest soon-and-own-follow-todays-arguments
  (doseq [k ["baton/done" "baton/asked-operator" "coding/settled" "build/merged" "build/merge-refused"]]
    (is (r/soon? {:kind k :params {}}) k))
  (doseq [k ["baton/closed" "baton/proposal" "reconcile/conflict" "reconcile/resolved" "reconcile/drafted"]]
    (is (not (r/soon? {:kind k :params {}})) k))
  (is (r/soon? {:kind "reconcile/promoted" :params {:n 1 :by "operator-explicit"}}))
  (is (not (r/own? {:kind "reconcile/promoted" :params {:n 1 :by "operator-explicit"}})))
  (is (r/own? {:kind "reconcile/promoted" :params {:n 1 :by "overseer"}}))
  (is (not (r/soon? {:kind "reconcile/promoted" :params {:n 1 :by "overseer"}})))
  (is (r/own? {:kind "reconcile/promoted" :params {:n 0 :by "operator-bulk"}}))
  (doseq [k ["reconcile/conflict" "reconcile/resolved" "reconcile/drafted"]] (is (r/own? {:kind k :params {}}) k)))

(deftest watch-text-is-todays
  (is (= (str "[project watch] Since your last look:\n- A.\n- B.\n\n"
           "Re-read the project (sova_project, and sova_decisions where it matters). Infer gaps against the roster's decision areas and file new ones as ideas (§gap/…). "
           "Then act within your autonomy (L1): the tools tell you when something needs a higher level. Keep your reply to a few lines for the operator.")
        (p/watch-text ["A." "B."] "L1")))
  (is (str/includes? (p/watch-text [] "L0") "- (the operator asked for a look)"))
  (is (= 20 (count (re-seq #"\n- " (str "\n" (p/watch-text (map str (range 30)) "L1")))))))

(deftest a-reason-starts-a-look-after-the-gap
  (let [x (host)]
    (is (= :quiet (watch-state x)))
    (h/send! x "p" :reason/noted closed-reason)
    ;; never looked: the gap has passed; the look starts at once
    (is (= :running (watch-state x)))
    (is (= 1 (count (looks x))))
    (is (= ["The gathering session \"Invoicing\" was closed."] (get-in (first (looks x)) [:params :reasons])))
    (is (str/starts-with? (get-in (first (looks x)) [:params :text]) "[project watch] Since your last look:\n- The gathering session"))
    (is (= "started" (:outcome (last-run x))))
    (is (= [] (reasons x)))
    (is (= 1 (:looks-today (h/data x "p"))))
    ;; a reason during the run waits
    (h/send! x "p" :reason/noted {:kind "baton/proposal" :params {:title "Invoicing"}})
    (h/send! x "p" :look/finished {})
    (is (= "finished" (:outcome (last-run x))))
    (is (= :waiting (watch-state x)))
    ;; the next look waits for the 10-minute gap after the last one started
    (h/advance! x (* 9 min-ms))
    (is (= :waiting (watch-state x)))
    (h/advance! x min-ms)
    (is (= :running (watch-state x)))
    (h/send! x "p" :look/finished {})
    (is (= :quiet (watch-state x)))))

(deftest a-soon-reason-looks-after-the-soon-delay
  (let [x (host)]
    (h/send! x "p" :operator/run-now {})
    (h/send! x "p" :look/finished {})
    (h/advance! x min-ms)
    (h/send! x "p" :reason/noted done-reason)
    (is (= :waiting (watch-state x)))
    (h/advance! x (dec min-ms))
    (is (= :waiting (watch-state x)))
    (h/advance! x 1)
    (is (= :running (watch-state x)))
    (testing "the first soon reason since the last look sets when; later ones don't move it"
      (h/send! x "p" :look/finished {})
      (h/advance! x min-ms)
      (h/send! x "p" :reason/noted done-reason)
      (let [at (:soon-at (h/data x "p"))]
        (h/advance! x 30000)
        (h/send! x "p" :reason/noted {:kind "coding/settled" :params {:title "B"}})
        (is (= at (:soon-at (h/data x "p"))))))))

(deftest soon-off-waits-for-the-gap
  (let [x (host {:settings {:soon-look-sec nil}})]
    (h/send! x "p" :operator/run-now {})
    (h/send! x "p" :look/finished {})
    (h/send! x "p" :reason/noted done-reason)
    (h/advance! x (* 5 min-ms))
    (is (= :waiting (watch-state x)))
    (h/advance! x (* 5 min-ms))
    (is (= :running (watch-state x)))))

(deftest reasons-are-deduped-by-text
  (let [x (host {:streaming true})]
    (h/send! x "p" :reason/noted closed-reason)
    (h/send! x "p" :reason/noted closed-reason)
    (is (= 1 (count (reasons x))))
    (h/send! x "p" :reason/noted {:kind "baton/closed" :params {:title "Other"}})
    (is (= 2 (count (reasons x))))))

(deftest own-acts-are-dropped-while-busy
  (let [x (host {:streaming true :settings {:watch false}})]
    (h/send! x "p" :reason/noted {:kind "reconcile/drafted" :params {:n 1}})
    (is (= [] (reasons x)) "today: dropped while the overseer streams")
    (h/send! x "p" :reason/noted {:kind "reconcile/drafted" :params {:n 2} :by "operator"})
    (is (= ["2 decisions are drafted and promotable."] (reasons x)) "R3: the operator's Reconcile is kept")
    (h/send! x "p" :overseer/idle {})
    (h/send! x "p" :overseer/busy {})
    (h/send! x "p" :reason/noted {:kind "reconcile/promoted" :params {:n 1 :by "overseer"}})
    (is (= 1 (count (reasons x))))))

(deftest the-gates-hold-a-due-look
  (testing "paused by an attach: waits, reasons kept, until the operator sets the level"
    (let [x (host {:paused true})]
      (h/send! x "p" :reason/noted closed-reason)
      (is (= :due (watch-state x)))
      (h/send! x "p" :operator/level-set {:autonomy "L2"})
      (is (= :running (watch-state x)))
      (is (= "L2" (get-in (first (looks x)) [:params :autonomy])))))
  (testing "archived: waits; the pause survives an archive and unarchive"
    (let [x (host {:paused true})]
      (h/send! x "p" :project/archived {})
      (h/send! x "p" :reason/noted closed-reason)
      (h/send! x "p" :project/unarchived {})
      (is (= :due (watch-state x)))
      (is (h/in? x "p" :paused))))
  (testing "watching off: waits"
    (let [x (host {:settings {:watch false}})]
      (h/send! x "p" :reason/noted closed-reason)
      (is (= :due (watch-state x)))
      (h/send! x "p" :settings/changed {:watch true})
      (is (= :running (watch-state x)))))
  (testing "a busy overseer (the operator's turn): waits until idle"
    (let [x (host {:streaming true})]
      (h/send! x "p" :reason/noted closed-reason)
      (is (= :due (watch-state x)))
      (h/send! x "p" :overseer/idle {})
      (is (= :running (watch-state x))))))

(deftest run-now
  (testing "skips the reasons, the gap and the switch; runs while paused (at L0)"
    (let [x (host {:paused true :settings {:watch false}})]
      (h/send! x "p" :operator/run-now {})
      (is (= :running (watch-state x)))
      (is (= "L0" (get-in (first (looks x)) [:params :autonomy])))
      (is (str/includes? (get-in (first (looks x)) [:params :text]) "- (the operator asked for a look)"))))
  (testing "refused while archived, busy or at the daily limit: a skipped run with why"
    (let [x (host {:archived true})]
      (h/send! x "p" :operator/run-now {})
      (is (= {:outcome "skipped" :detail "the project is archived"} (select-keys (last-run x) [:outcome :detail]))))
    (let [x (host {:streaming true})]
      (h/send! x "p" :operator/run-now {})
      (is (= "busy" (:detail (last-run x)))))
    (let [x (host {:settings {:caps {:unattended-per-day 1}}})]
      (h/send! x "p" :operator/run-now {})
      (h/send! x "p" :look/finished {})
      (h/send! x "p" :operator/run-now {})
      (is (= "the daily limit of 1 unattended runs is reached" (:detail (last-run x))))
      (is (= ["looks"] (mapv :key (:held (h/data x "p"))))))))

(deftest the-daily-looks-hold-until-midnight
  (let [x (host {:settings {:caps {:unattended-per-day 1}}})]
    (h/send! x "p" :reason/noted closed-reason)
    (h/send! x "p" :look/finished {})
    (h/send! x "p" :reason/noted {:kind "baton/proposal" :params {:title "Invoicing"}})
    (h/advance! x (* 10 min-ms))
    (is (= :held (watch-state x)))
    (is (= "skipped" (:outcome (last-run x))))
    (is (= "Today's 1 looks on its own are used." (:why (first (:held (h/data x "p"))))))
    (let [midnight (c/next-midnight (h/now x))]
      (h/advance! x (- midnight (h/now x)))
      (is (= 1 (:looks-today (h/data x "p"))) "reset at midnight, then the day's first look")
      (is (= :running (watch-state x)))
      (is (some #(str/starts-with? % "Today's looks are back (refused ") (get-in (last (looks x)) [:params :reasons]))))))

(deftest a-stopped-or-cut-off-run-keeps-its-reasons
  (let [x (host)]
    (h/send! x "p" :reason/noted closed-reason)
    (h/send! x "p" :reason/noted {:kind "baton/proposal" :params {:title "X"}})
    (h/send! x "p" :look/stopped {:detail "Stopped."})
    (is (= {:outcome "stopped" :detail "Stopped."} (select-keys (last-run x) [:outcome :detail])))
    (is (= ["The gathering session \"Invoicing\" was closed." "Someone was referred in \"X\" (a proposed roster person)."] (reasons x)))
    (is (= :waiting (watch-state x))))
  (let [x (host)]
    (h/send! x "p" :reason/noted closed-reason)
    (h/send! x "p" :sova/resumed {})
    (is (= {:outcome "cut-off" :detail "The server restarted during the run."} (select-keys (last-run x) [:outcome :detail])))
    (is (= 1 (count (reasons x))))))

(deftest a-look-that-never-started-is-skipped-and-retried
  (let [x (host)]
    (h/send! x "p" :reason/noted closed-reason)
    (h/send! x "p" :look/not-started {:detail "The model is not allowed."})
    (is (= {:outcome "skipped" :detail "The model is not allowed."} (select-keys (last-run x) [:outcome :detail])))
    (is (= 0 (:looks-today (h/data x "p"))))
    (is (nil? (:last-run-at (h/data x "p"))))
    (is (= :waiting (watch-state x)))
    (h/advance! x 19999)
    (is (= :waiting (watch-state x)))
    (h/advance! x 1)
    (is (= :running (watch-state x)))))

(deftest held-allowances
  (testing "a day allowance: held until midnight, then a reason to look soon"
    (let [x (host {:streaming true})]
      (h/send! x "p" :limit/refused {:ledger "day" :kind "gather" :used 6 :max 6})
      (is (= [{:key "day:gather" :why "Today's allowance is used: 6 of 6 gathering sessions started on its own."}]
            (mapv #(select-keys % [:key :why]) (:held (h/data x "p")))))
      (h/advance! x (- (c/next-midnight (h/now x)) (h/now x)))
      (is (= [] (:held (h/data x "p"))))
      (is (str/starts-with? (first (reasons x)) "Today's allowance is back: it may start gathering sessions again (refused "))
      (is (some? (:soon-at (h/data x "p"))))))
  (testing "the message allowance: a reason at the normal pace, at once"
    (let [x (host {:streaming true})]
      (h/send! x "p" :limit/refused {:ledger "message" :kind "promote" :used 20 :max 20})
      (is (= ["The operator's last message reached its limit on decisions promoted; it may go on within today's allowance."] (reasons x)))
      (is (nil? (:soon-at (h/data x "p"))))))
  (testing "raising a limit releases what it held"
    (let [x (host {:streaming true})]
      (h/send! x "p" :limit/refused {:ledger "day" :kind "create" :used 4 :max 4})
      (h/send! x "p" :settings/changed {:caps {:create-per-day nil}})
      (is (= ["You raised the limit on coding sessions started."] (reasons x)))
      (is (= [] (:held (h/data x "p")))))))

(deftest a-shorter-gap-re-arms-the-wait
  (let [x (host)]
    (h/send! x "p" :operator/run-now {})
    (h/send! x "p" :look/finished {})
    (h/send! x "p" :reason/noted closed-reason)
    (h/advance! x (* 2 min-ms))
    (is (= :waiting (watch-state x)))
    (h/send! x "p" :settings/changed {:watch-gap-min 2})
    (is (= :running (watch-state x)))))

(deftest items-tell-the-project
  (let [x (host)]
    (h/start! x :work-item "i" {:item-id "§gap/invoicing" :project-sid "p" :stall-after-ms {:open 1000}})
    (h/send! x "p" :overseer/busy {})
    (h/advance! x 1000)
    (is (h/in? x "i" :stalled))
    (is (= [{:kind "item/stalled" :text (str "The gap §gap/invoicing has waited in open since " (c/clock-time (- (h/now x) 1000)) ".")}]
          (mapv #(select-keys % [:kind :text]) (:reasons (h/data x "p")))))))

(deftest item-less-tool-calls
  (let [x   (host)
        env {:by "overseer" :attended false :autonomy "L1" :paused false :roster-active true
             :allowance {:gather {:used 0 :max 6} :promote {:used 59 :max 60}}
             :at-once {:gatherings-open 1 :gatherings-cap 5}}
        why #(g/explain "project" :overseer/act (h/data x "p") (merge env %))]
    (is (nil? (why {:tool "sova_note"})))
    (is (nil? (why {:tool "sova_project"})))
    (is (nil? (why {:tool "sova_offer"})))
    (is (nil? (why {:tool "sova_roster" :op "read"})))
    (is (str/includes? (why {:tool "sova_roster" :op "approve"}) "sova_roster needs L2."))
    (is (str/includes? (why {:tool "sova_promote" :n 1}) "sova_promote needs L2."))
    (is (= "sova_todo changes the operator's own to-do list, so it runs only in a turn the operator started. Raise a sova_confirm card with what you would change."
          (why {:tool "sova_todo"})))
    (is (str/starts-with? (why {:tool "sova_todos"}) "The to-do list is the operator's own"))
    (is (nil? (why {:tool "sova_todo" :attended true})))
    (is (= "No owner." (why {:tool "sova_owner_update" :invalid "No owner."})))
    (is (str/starts-with? (why {:tool "sova_promote" :n 2 :autonomy "L2"}) "Today's allowance is used: 59 of 60 decisions promoted on its own."))
    (is (str/starts-with? (why {:tool "sova_start_gathering" :at-once {:gatherings-open 5 :gatherings-cap 5}}) "5 of its gathering sessions are open"))
    (testing "a refused act is not taken; one that may run is recorded"
      (h/send! x "p" :overseer/act (merge env {:tool "sova_promote" :n 1}))
      (is (empty? (:log (h/data x "p"))))
      (h/send! x "p" :overseer/act (merge env {:tool "sova_note"}))
      (is (= {:event "overseer/act" :tool "sova_note" :verdict "ok"} (select-keys (last (:log (h/data x "p"))) [:event :tool :verdict]))))))

(deftest looks-start-on-the-watch-tick
  (testing "reasons noted within one tick join one look (the 20 s ticker, phased from the server's start)"
    (let [x (host {:tick-origin 7000})]
      (h/send! x "p" :reason/noted closed-reason)
      (is (= :waiting (watch-state x)))
      (h/advance! x 5000)
      (h/send! x "p" :reason/noted {:kind "baton/proposal" :params {:title "Invoicing"}})
      (h/advance! x 1999)
      (is (= :waiting (watch-state x)))
      (h/advance! x 1)
      (is (= :running (watch-state x)))
      (is (= 2 (count (get-in (first (looks x)) [:params :reasons]))))))
  (testing "tick 0: the exact due time"
    (let [x (host {:tick-origin 7000 :tick-ms 0})]
      (h/send! x "p" :reason/noted closed-reason)
      (is (= :running (watch-state x))))))

(deftest run-now-explained
  (let [x (host {:archived true})]
    (is (= "the project is archived" (g/explain "project" :operator/run-now (assoc (h/data x "p") :sova/configuration (h/config x "p")) {}))))
  (let [x (host)]
    (is (nil? (g/explain "project" :operator/run-now (assoc (h/data x "p") :sova/configuration (h/config x "p")) {})))))

(deftest held-items-wait-out-a-pause
  (let [x (host {:paused true :streaming true})]
    (h/send! x "p" :limit/refused {:ledger "message" :kind "prompt" :used 5 :max 5})
    (is (= ["message:prompt"] (mapv :key (:held (h/data x "p")))) "paused: today's tick releases nothing")
    (h/send! x "p" :operator/level-set {:autonomy "L3"})
    (is (= [] (:held (h/data x "p"))))
    (is (= ["The operator's last message reached its limit on prompts to coding sessions; it may go on within today's allowance."] (reasons x))))
  (let [x (host {:archived true :streaming true})]
    (h/send! x "p" :limit/refused {:ledger "day" :kind "create" :used 4 :max 4})
    (h/advance! x (- (c/next-midnight (h/now x)) (h/now x)))
    (is (= ["day:create"] (mapv :key (:held (h/data x "p")))) "archived over midnight: still held")
    (h/send! x "p" :project/unarchived {})
    (is (= [] (:held (h/data x "p"))))
    (is (str/starts-with? (first (reasons x)) "Today's allowance is back: it may start coding sessions again"))))

(deftest streaming-and-queued-are-two-facts
  (testing "a queued prompt with nothing streaming: own reasons kept (isStreaming), no look (not idle)"
    (let [x (host {:queued 1})]
      (h/send! x "p" :reason/noted {:kind "reconcile/drafted" :params {:n 1}})
      (is (= ["1 decision is drafted and promotable."] (reasons x)))
      (is (= :due (watch-state x)))
      (h/send! x "p" :facts/changed {:queued 0})
      (is (= :running (watch-state x))))))

(deftest a-longer-gap-re-arms-the-wait-too
  (testing "the old due timer is cancelled: raising the gap while waiting delays the look"
    (let [x (host)]
      (h/send! x "p" :operator/run-now {})
      (h/send! x "p" :look/finished {})
      (h/send! x "p" :reason/noted closed-reason)
      (h/advance! x (* 2 min-ms))
      (h/send! x "p" :settings/changed {:watch-gap-min 30})
      (is (= [[:watch/due (+ (h/now x) (* 28 min-ms))]] (filterv #(= :watch/due (first %)) (h/pending-sends x "p"))))
      (h/advance! x (* 8 min-ms))
      (is (= :waiting (watch-state x)) "not at the old 10-minute mark")
      (h/advance! x (* 20 min-ms))
      (is (= :running (watch-state x))))))
