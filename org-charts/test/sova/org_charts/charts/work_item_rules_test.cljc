(ns sova.org-charts.charts.work-item-rules-test
  "The work-item rules one at a time, with today's sentences: caps, promote verdicts, closing a
   gathering, the tool's own refusals, stale facts, attempts, coverage of a build, stall clocks,
   the outbox and explain through the engine's entry point."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [clojure.string :as str]
    [sova.org-charts.charts.events :as ev]
    [sova.org-charts.charts.facts :as f]
    [sova.org-charts.charts.guards :as g]
    [sova.org-charts.charts.harness :as h]
    [sova.org-charts.charts.project]
    [sova.org-charts.charts.work-item :as wi]
    [sova.org-charts.charts.work-item-matrix-test :as m]))

(defn explain [host ev env]
  (g/explain "work-item" ev (assoc (h/data host "item") :sova/configuration (h/config host "item") :sova/running? (h/running? host "item")) env))

(def l3 (:l3 m/envelopes))
(def op (:operator m/envelopes))

(deftest caps-refuse-with-todays-sentences
  (let [host (m/place :open)]
    (is (= (str "5 of its gathering sessions are open, and the limit is 5 at once. "
             "One reaching its goal or being closed is a reason to look again; don't promise when.")
          (explain host :gather/start (merge l3 m/gather-args {:at-once m/full}))))
    (is (= (str "Today's allowance is used: 6 of 6 gathering sessions started on its own. It looks again at midnight. "
             "Nothing starts before then. Tell the operator what is waiting; don't promise an earlier look.")
          (explain host :gather/start (merge l3 m/gather-args {:allowance m/spent}))))
    (is (= (str "This message's allowance is used: 3 of 3 gathering sessions started per message you send. "
             "Stop here and tell the operator what is done and what is left, or ask with sova_card.")
          (explain host :gather/start (merge (:attended m/envelopes) m/gather-args {:allowance {:gather {:used 3 :max 3}}}))))
    (is (nil? (explain host :gather/start (merge l3 m/gather-args {:allowance {:gather {:used 6 :max nil}}})))
      "Unlimited (max null) never refuses"))
  (let [host (m/place :awaiting-build)]
    (is (= (str "2 of its coding sessions are running, and the limit is 2 at once. "
             "One finishing its turn is a reason to look again; don't promise when.")
          (explain host :build/start (merge l3 {:prompt "Build" :at-once m/full}))))))

(deftest the-level-in-force
  (let [host (m/place :awaiting-build)]
    (is (str/includes? (explain host :build/start (merge l3 {:prompt "B" :roster-active false}))
          "your autonomy here is L0 (The roster has no active people yet, so the overseer only proposes (L0).); sova_create_session needs L3."))
    (is (str/includes? (explain host :build/start (merge l3 {:prompt "B" :paused true :roster-active false}))
          "(Paused at L0: this organization was attached on this host. Set its level to resume.)")
      "paused wins over an empty roster")
    (is (nil? (explain host :build/start (merge l3 {:prompt "B" :paused true :attended true})))
      "an attended run gets every tool, paused or not")
    (is (some? (explain host :build/start (merge l3 {:prompt "B" :autonomy "L9"})))
      "an unknown level refuses (TS indexOf = -1)")))

(deftest the-tools-own-refusals-come-after-the-level
  (let [host (m/place :open)]
    (is (= "Reading links is off for this project." (explain host :gather/start (merge l3 m/gather-args {:invalid "Reading links is off for this project."}))))
    (is (str/includes? (explain host :gather/start (merge (:l0 m/envelopes) m/gather-args {:invalid "x"})) "needs L1")
      "the level is checked first")
    (is (= "Reading links is off for this project."
          (explain host :gather/start (merge l3 m/gather-args {:invalid "Reading links is off for this project." :at-once m/full})))
      "and before the caps")))

(deftest promote-verdicts
  (let [host (m/place :drafted)
        d2   (m/decision "drafted" :id "d2" :author-owns-area false :name "Bo")]
    (h/send! host "item" :facts/changed {:decisions [(m/decision "drafted") d2 (m/decision "superseded" :id "d3")]})
    (testing "over the allowance: refused whole before anything"
      (is (str/starts-with? (explain host :decision/promote (merge l3 {:ids ["d1" "d2"] :allowance {:promote {:used 59 :max 60}}}))
            "Today's allowance is used: 59 of 60 decisions promoted on its own.")))
    (testing "every id refused: the reconciler's reasons"
      (is (= (str "Promoted 0, refused 3: d2 (outside Bo's decision area: promote it explicitly by id); "
               "d3 (it is superseded; only a reconciled (drafted) decision can be promoted); zz (unknown decision).")
            (explain host :decision/promote (merge l3 {:ids ["d2" "d3" "zz"]})))))
    (testing "the overseer never promotes out of area, attended or not; the operator's explicit promote does"
      (is (some? (explain host :decision/promote (merge (:attended m/envelopes) {:ids ["d2"]}))))
      (is (nil? (explain host :decision/promote (merge op {:ids ["d2"]}))))
      (is (some? (explain host :decision/promote (merge op {:ids ["d2"] :bulk true})))))
    (testing "partly promotable: taken, the effect names only what may be promoted"
      (h/send! host "item" :decision/promote (merge l3 {:ids ["d1" "d2" "d3"]}))
      (is (= {:kind "promote" :ids ["d1"] :by "overseer"} (select-keys (last (h/outbox host "item")) [:kind :ids :by]))))))

(deftest closing-a-gathering
  (let [cases [[{} nil]
               [{:own false} "Not one of your gathering sessions."]
               [{:settle true} "That is a settle session: the conflict ends when it is settled."]
               [{:wrote true} "Someone it went to has already written in it."]]]
    (doseq [[b why] cases]
      (let [host (m/place :asking)]
        (h/send! host "item" :facts/changed {:baton (merge m/baton-open b)})
        (is (= why (explain host :gather/close (merge l3 {:reason "Covered"}))) (pr-str b)))))
  (let [host (m/place :asking)]
    (is (= "Say why you close it (reason)." (explain host :gather/close l3)))
    (is (nil? (explain host :gather/close (merge op {}))) "the operator's Close needs no reason")
    (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :wrote true)})
    (is (nil? (explain host :gather/close op)) "and closes one someone wrote in")))

(deftest a-new-attempt-ignores-the-old-batons-facts
  (let [host (m/place :asking)]
    (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :state "closed")})
    (is (= :open (m/lane host)))
    (is (= 1 (:attempts (h/data host "item"))))
    (h/send! host "item" :gather/start (merge op m/gather-args))
    (is (= :gather-starting (m/lane host)))
    (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :state "closed")})
    (is (= :gather-starting (m/lane host)) "the closed baton is the previous one")
    (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :id "b2")})
    (is (= :asking (m/lane host)))))

(deftest done-with-nothing-then-a-late-decision
  (let [host (h/new-host)]
    (h/start! host :project "project" {:project-sid "project" :roster-active true :streaming true})
    (h/start! host :work-item "item" {:item-id "§gap/x" :project-sid "project"})
    (h/send! host "item" :facts/changed {:baton m/baton-open})
    (h/send! host "item" :facts/changed {:baton m/done-baton :decisions []})
    (is (= :open (m/lane host)))
    (is (= ["The gathering session for §gap/x ended with no decision."] (mapv :text (:reasons (h/data host "project")))))
    (testing "goal_done's event can precede its decision entry: the decision still moves the item"
      (h/send! host "item" :facts/changed {:decisions [(m/decision "pending")]})
      (is (= :unreconciled (m/lane host))))))

(deftest a-build-covers-the-decisions-it-names
  (let [host (m/place :merged)
        b    (assoc m/build-base :merged true :state "merged" :decision-ids ["d1"])]
    (h/send! host "item" :facts/changed {:build b})
    (is (= :merged (m/lane host)))
    (testing "a decision promoted since, not in the build: awaiting a build of its own"
      (h/send! host "item" :facts/changed {:decisions [(m/decision "promoted") (m/decision "promoted" :id "d9")]})
      (is (= :awaiting-build (m/lane host))))
    (testing "a new build naming both takes it through"
      (h/send! host "item" :build/start (merge op {:prompt "More"}))
      (is (= "start-coding" (:kind (last (h/outbox host "item")))))
      (is (= ["d1" "d9"] (:decisions (last (h/outbox host "item")))))
      (h/send! host "item" :facts/changed {:build (assoc m/build-base :session-id "c2" :running true :decision-ids ["d1" "d9"])})
      (is (= :working (m/lane host))))))

(deftest a-gap-marked-done-goes-on-to-be-built
  (testing "real-26: gathering done → reconcile → sova_idea status done → promote → build; done means answered"
    (let [host (m/place :drafted)]
      (h/send! host "item" :gap/status (merge l3 {:status "done"}))
      (is (= :drafted (m/lane host)) "the status is recorded, the item stays where its facts put it")
      (is (= "done" (:idea-status (h/data host "item"))))
      (is (nil? (explain host :decision/promote (merge l3 {:ids ["d1"]}))))
      (h/send! host "item" :decision/promote (merge l3 {:ids ["d1"]}))
      (is (= "promote" (:kind (last (h/outbox host "item")))))
      (h/send! host "item" :facts/changed {:decisions [(m/decision "promoted")]})
      (is (= :awaiting-build (m/lane host)))
      (is (nil? (explain host :build/start (merge l3 {:prompt "Build it"}))))
      (h/send! host "item" :build/start (merge l3 {:prompt "Build it"}))
      (is (= :build-starting (m/lane host)))))
  (testing "any status but dropped leaves the item where it is, in every state"
    (doseq [s (remove #{:dropped} m/rows)
            status ["open" "exploring" "started" "done"]]
      (let [host (m/place s)]
        (h/send! host "item" :gap/status (merge l3 {:status status}))
        (is (= s (m/lane host)) (str (name s) " × " status))))))

(deftest dropped-is-final
  (let [host (m/place :idle)]
    (h/send! host "item" :gap/status (merge (:l0 m/envelopes) {:status "dropped"}))
    (is (= #{:item :dropped} (h/config host "item")))
    (is (h/running? host "item") "nested final: the session stays readable")
    (is (= "idle" (:dropped-from (h/data host "item"))))
    (h/send! host "item" :gap/status (merge op {:status "open"}))
    (h/send! host "item" :facts/changed {:baton m/baton-open})
    (is (= #{:item :dropped} (h/config host "item")))
    (is (= "This idea was dropped; dropped is final. File a new idea instead." (explain host :gap/status (merge op {:status "open"}))))))

(deftest not-this-phase
  (let [host (m/place :on-hold)]
    (is (= "§gap/invoicing is on hold: only the operator resumes it." (explain host :decision/reconcile l3)))
    (is (= "Only the operator resumes an item, from the project page." (explain host :item/resume l3))))
  (let [host (m/place :open)]
    (is (= "§gap/invoicing is open: build/start applies once its decisions are promoted, before a build or after a merge."
          (explain host :build/start (merge l3 {:prompt "x"}))))))

(deftest stall-clocks
  (let [host (h/new-host)]
    (h/start! host :project "project" {:project-sid "project" :roster-active true :streaming true})
    (h/start! host :work-item "item" {:item-id "§gap/x" :project-sid "project" :stall-after-ms {:asking 1000 :needs-operator 5000}})
    (h/send! host "item" :facts/changed {:baton m/baton-open})
    (h/advance! host 999)
    (is (h/in? host "item" :calm))
    (h/advance! host 1)
    (is (h/in? host "item" :stalled))
    (testing "moving on calms it and cancels the old clock; the new phase has its own"
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :state "needs-you")})
      (is (h/in? host "item" :calm))
      (is (= [[:item/stalled (+ (h/now host) 5000)]] (h/pending-sends host "item"))))
    (testing "a phase with no clock arms none"
      (h/send! host "item" :facts/changed {:baton m/done-baton :decisions [(m/decision "promoted")] :build (assoc m/build-base :running true)})
      (is (= :working (m/lane host)))
      (is (= [] (h/pending-sends host "item"))))
    (is (= 1 (count (filter #(= "item/stalled" (:kind %)) (:reasons (h/data host "project"))))))))

(deftest effect-keys-are-unique
  (let [host (m/place :idle)]
    (dotimes [_ 3] (h/send! host "item" :build/prompt (merge op {:text "again"})))
    (let [keys (map :key (h/outbox host "item"))]
      (is (= (count keys) (count (set keys))))
      (is (every? #(str/starts-with? % "§gap/invoicing/") keys)))))

(defn chart-events
  "Every event name a transition of `chart` names."
  [chart]
  (set (for [el (vals (:com.fulcrologic.statecharts/elements-by-id chart))
             :when (= :transition (:node-type el))
             :let [ev (:event el)]
             :when ev
             e (if (keyword? ev) [ev] ev)]
         e)))

(deftest the-vocabulary-covers-every-event-the-charts-name
  (doseq [[k chart all] [[:work-item wi/chart wi/all-events] [:project sova.org-charts.charts.project/chart sova.org-charts.charts.project/all-events]]]
    (is (= (set all) (chart-events chart)) (str (name k) ": all-events lists exactly the events its transitions name"))
    (is (= (set all) (set (keys (get ev/schemas k)))) (str (name k) ": a schema for every event, none extra"))))

(deftest schemas-accept-the-tests-own-events-and-refuse-bad-ones
  (is (nil? (ev/problems :work-item :gather/start (merge l3 m/gather-args))))
  (is (some? (ev/problems :work-item :gather/start (merge l3 (dissoc m/gather-args :question)))))
  (is (some? (ev/problems :work-item :gap/status {:status "finished"})))
  (is (nil? (ev/problems :work-item :facts/changed {:baton m/baton-open :decisions [(m/decision "drafted")] :build m/build-base})))
  (is (nil? (ev/problems :project :reason/noted {:kind "baton/done" :params {:title "T"}})))
  (is (nil? (ev/problems :project :overseer/act (merge l3 {:tool "sova_note"}))))
  (is (some? (ev/problems :work-item :nope/nope {}))))

;; ---- mutants the verifier found surviving -------------------------------------------------------------

(deftest every-waiting-phase-stalls-on-its-own-clock
  (testing "each phase with a clock stalls when the clock (not an injected event) fires; the others never do"
    (doseq [s m/rows
            :when (not= s :dropped)]
      (let [host (m/place s)]
        (h/advance! host (* 3 24 3600 1000))
        (is (= (contains? wi/stall-phases s) (h/in? host "item" :stalled)) (name s))
        (is (= s (m/lane host)) (str (name s) " stays where it is"))))))

(deftest the-decision-phase-precedence
  (is (= "none" (f/dphase [])))
  (is (= "none" (f/dphase [(m/decision "superseded")])))
  (is (= "conflict" (f/dphase [(m/decision "pending") (m/decision "conflict") (m/decision "drafted")])))
  (is (= "pending" (f/dphase [(m/decision "drafted") (m/decision "pending") (m/decision "promoted")])))
  (is (= "drafted" (f/dphase [(m/decision "promoted") (m/decision "drafted")])))
  (is (= "edited" (f/dphase [(m/decision "promoted") (m/decision "promoted" :edited-in-spec true)])))
  (is (= "promoted" (f/dphase [(m/decision "promoted") (m/decision "superseded")])))
  (let [host (m/place :drafted)]
    (h/send! host "item" :facts/changed {:decisions [(m/decision "pending") (m/decision "conflict" :id "d2")]})
    (is (= :conflicted (m/lane host)) "a conflict outranks a pending decision")))

(deftest a-stale-ended-baton-does-not-bounce-a-new-attempt
  (doseq [stale ["done" "closed"]]
    (let [host (m/place :asking)]
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :state stale) :decisions []})
      (is (= :open (m/lane host)))
      (h/send! host "item" :gather/start (merge op m/gather-args))
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :state stale) :decisions []})
      (is (= :gather-starting (m/lane host)) stale)
      (is (= 1 (:attempts (h/data host "item"))) "the old baton is not counted twice"))))

(deftest resume-never-starts-a-second-build
  (let [host (m/place :build-starting)
        n    (count (h/outbox host "item"))]
    (h/send! host "item" :item/hold op)
    (h/send! host "item" :item/resume op)
    (is (= :build-starting (m/lane host)) "deep history: back in the starting build, not awaiting one")
    (is (some? (explain host :build/start (merge op {:prompt "again"}))))
    (h/send! host "item" :build/start (merge op {:prompt "again"}))
    (is (= n (count (h/outbox host "item"))) "no second start-coding effect")))

(deftest caps-bind-every-counted-act
  (doseq [[state ev d kind] [[:open :gather/start m/gather-args :gather]
                             [:drafted :decision/promote {:ids ["d1"]} :promote]
                             [:awaiting-build :build/start {:prompt "B"} :create]
                             [:idle :build/prompt {:text "go"} :prompt]]]
    (testing (name ev)
      (let [host (m/place state)
            full {:allowance {kind {:used 1 :max 1}}}]
        (is (str/starts-with? (explain host ev (merge l3 d full)) "Today's allowance is used: 1 of 1"))
        (is (str/starts-with? (explain host ev (merge (:attended m/envelopes) d full)) "This message's allowance is used: 1 of 1"))
        (is (nil? (explain host ev (merge l3 d {:allowance {kind {:used 0 :max 1}}}))) "one left is enough")
        (h/send! host "item" ev (merge l3 d full))
        (is (= state (m/lane host)) "refused: nothing moves")
        (is (empty? (h/outbox host "item")) "refused: no effect"))))
  (testing "the allowance counts n: promoting 2 ids with 1 left is refused whole"
    (let [host (m/place :drafted)]
      (h/send! host "item" :facts/changed {:decisions [(m/decision "drafted") (m/decision "drafted" :id "d2")]})
      (is (some? (explain host :decision/promote (merge l3 {:ids ["d1" "d2"] :allowance {:promote {:used 59 :max 60}}}))))
      (is (nil? (explain host :decision/promote (merge l3 {:ids ["d1"] :allowance {:promote {:used 59 :max 60}}}))))))
  (testing "at-once limits bind gathering and building, attended too"
    (doseq [[state ev d] [[:open :gather/start m/gather-args] [:awaiting-build :build/start {:prompt "B"}]]]
      (let [host (m/place state)]
        (is (some? (explain host ev (merge (:attended m/envelopes) d {:at-once m/full}))))
        (is (nil? (explain host ev (merge (:attended m/envelopes) d {:at-once m/room}))))))))

(deftest promote-refuses-only-when-every-id-is-refused
  (let [host (m/place :drafted)]
    (h/send! host "item" :facts/changed {:decisions [(m/decision "drafted") (m/decision "superseded" :id "d2")]})
    (is (nil? (explain host :decision/promote (merge l3 {:ids ["d1" "d2" "zz"]}))))
    (is (some? (explain host :decision/promote (merge l3 {:ids ["d2" "zz"]}))))))

(deftest attended-passes-every-level-never-the-caps
  (let [host (m/place :awaiting-build)
        att  (merge (:attended m/envelopes) {:prompt "B" :autonomy "L0" :paused true :roster-active false})]
    (is (nil? (explain host :build/start att)))
    (is (some? (explain host :build/start (assoc att :attended false))))
    (is (some? (explain host :build/start (assoc att :allowance m/spent))))))

(deftest promote-while-a-follow-up-gathering-is-in-flight
  (testing "real-26: a drafted decision is promoted while the gap's follow-up gathering waits on the operator"
    (let [host (m/place :drafted)]
      (h/send! host "item" :gather/start (merge l3 m/gather-args))
      (is (h/in? host "item" :follow-up-starting))
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :id "b2" :state "needs-you")
                                           :decisions [(m/decision "drafted") (m/decision "drafted" :id "d9")]})
      (is (= :drafted (m/lane host)) "a follow-up gathering leaves the lane to the decisions")
      (is (h/in? host "item" :follow-up-needs-operator))
      (is (nil? (explain host :decision/promote (merge l3 {:ids ["d1" "d9"]}))))
      (is (nil? (explain host :decision/reconcile l3)))
      (h/send! host "item" :decision/promote (merge l3 {:ids ["d1" "d9"]}))
      (is (= {:kind "promote" :ids ["d1" "d9"]} (select-keys (last (h/outbox host "item")) [:kind :ids])))
      (h/send! host "item" :facts/changed {:decisions [(m/decision "promoted") (m/decision "promoted" :id "d9")]})
      (is (= :awaiting-build (m/lane host)))
      (is (h/in? host "item" :follow-up-needs-operator))
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :id "b2" :state "done")})
      (is (h/in? host "item" :no-follow-up))))
  (testing "in every pipeline phase, promote is taken exactly when an asked id is a drafted decision of the item"
    (doseq [s (remove #{:dropped :on-hold} m/rows)]
      (let [host (m/place s)]
        (h/send! host "item" :facts/changed {:decisions (conj (vec (:decisions (h/data host "item"))) (m/decision "drafted" :id "dx"))})
        (let [lane (m/lane host)]
          (is (nil? (explain host :decision/promote (merge l3 {:ids ["dx"]}))) (str (name s) " → " (name lane)))
          (is (some? (explain host :decision/promote (merge l3 {:ids ["nope"]}))) (name s)))))))

(deftest a-follow-up-gathering-runs-beside-the-build
  (testing "real-26: a follow-up gathering waits on the operator while the build works and merges"
    (let [host (m/place :idle)]
      (h/send! host "item" :gather/start (merge l3 m/gather-args))
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :id "b2" :state "needs-you")})
      (is (h/in? host "item" :follow-up-needs-operator))
      (is (= :idle (m/lane host)))
      (is (nil? (explain host :build/merge op)) "Merge Branch is not blocked by the question")
      (is (nil? (explain host :build/prompt (merge l3 {:text "go on"}))))
      (is (nil? (explain host :gather/close (merge l3 {:reason "covered"}))) "the follow-up can be closed")
      (h/send! host "item" :facts/changed {:build (assoc m/build-base :merged true :state "merged")})
      (is (= :merged (m/lane host)))
      (is (h/in? host "item" :follow-up-needs-operator))
      (testing "its decisions join the item's and reopen it through the facts"
        (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :id "b2" :state "done")
                                             :decisions [(m/decision "promoted") (m/decision "drafted" :id "d9")]})
        (is (h/in? host "item" :no-follow-up))
        (is (= :drafted (m/lane host))))))
  (testing "one follow-up at a time, but a live one may be replaced; none while one starts"
    (let [host (m/place :drafted)]
      (h/send! host "item" :gather/start (merge l3 m/gather-args))
      (is (some? (explain host :gather/start (merge l3 m/gather-args))))
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :id "b2")})
      (is (h/in? host "item" :follow-up-asking))
      (is (nil? (explain host :gather/start (merge l3 m/gather-args))))
      (h/send! host "item" :gather/start (merge l3 m/gather-args))
      (is (h/in? host "item" :follow-up-starting))
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :id "b2")})
      (is (h/in? host "item" :follow-up-starting) "the replaced baton's facts don't count")))
  (testing "a follow-up that fails to start leaves nothing live"
    (let [host (m/place :merged)]
      (h/send! host "item" :gather/start (merge l3 m/gather-args))
      (h/send! host "item" :effect/failed {:kind "start-gathering"})
      (is (h/in? host "item" :no-follow-up))
      (is (= :merged (m/lane host)))))
  (testing "a follow-up's stall clock stalls the item"
    (let [host (m/place :done)]
      (h/send! host "item" :gather/start (merge l3 m/gather-args))
      (h/send! host "item" :facts/changed {:baton (assoc m/baton-open :id "b2")})
      (h/advance! host (* 3 24 3600 1000))
      (is (h/in? host "item" :stalled)))))

;; ---- the follow-up region, by sending (verifier FINAL: N08, N09, N11, F1, N02) --------------------------

(defn- stalled-reasons
  "The phases of the item/stalled reasons the project holds, waiting or taken by a look that started."
  [host]
  (let [d (h/data host "project")]
    (vec (for [r (concat (:run-reasons d) (:reasons d)) :when (= "item/stalled" (:kind r))] (get-in r [:params :phase])))))

(deftest every-follow-up-state-stalls-on-its-own-clock
  (testing "beside a lane with no clock of its own (working, done), a live follow-up stalls the item when its
            clock fires, and names its phase; one starting, or none, never does"
    (doseq [s  [:working :done]
            fu m/fu-states]
      (let [host (m/place s fu)]
        (h/advance! host (* 3 24 3600 1000))
        (is (= (contains? wi/stall-phases fu) (h/in? host "item" :stalled)) (str (name s) " + " (name fu)))
        (is (= (if (contains? wi/stall-phases fu) [(name fu)] [])
              (stalled-reasons host))
          (str (name s) " + " (name fu) ": the reason names the follow-up's phase"))
        (is (= [s fu] [(m/lane host) (m/follow-up-state host)]) "nothing else moves"))))
  (testing "the follow-up's clock is its own: the lane moving on does not re-arm or cancel it"
    (let [host (m/place :working :follow-up-needs-operator)]
      (h/advance! host (* 2 24 3600 1000))
      (h/send! host "item" :facts/changed {:build m/build-base})
      (is (= :idle (m/lane host)))
      (h/advance! host (* 1 24 3600 1000))
      (is (h/in? host "item" :stalled))
      (is (= ["follow-up-needs-operator"]
            (stalled-reasons host))))))

(deftest a-follow-ups-effects-carry-what-the-host-needs
  (testing "gather/start as a follow-up emits the lane's start-gathering effect, field for field"
    (let [lane-fx (let [host (m/place :open)]
                    (h/send! host "item" :gather/start (merge l3 m/gather-args))
                    (dissoc (last (h/outbox host "item")) :at))
          host    (m/place :idle)
          n       (count (h/outbox host "item"))]
      (h/send! host "item" :gather/start (merge l3 m/gather-args))
      (is (= :follow-up-starting (m/follow-up-state host)))
      (is (= [(assoc lane-fx :key (str "§gap/invoicing/start-gathering/" n))]
            (map #(dissoc % :at) (drop n (h/outbox host "item")))))
      (is (= {:kind "start-gathering" :gap "§gap/invoicing" :to "p1" :public-title "Invoicing"
              :question "How do you invoice?" :goal "Learn invoicing"}
            (dissoc lane-fx :key)))))
  (testing "closing the follow-up names its own session, not the lane's first one"
    (doseq [fu [:follow-up-asking :follow-up-needs-operator]]
      (let [host (m/place :merged fu)
            n    (count (h/outbox host "item"))]
        (h/send! host "item" :gather/close (merge l3 {:reason "covered"}))
        (is (= [{:kind "close-gathering" :session-id "b2" :reason "covered"}]
              (map #(select-keys % [:kind :session-id :reason]) (drop n (h/outbox host "item")))) (name fu))
        (testing "the close is an intent: the follow-up ends when its baton does"
          (is (= fu (m/follow-up-state host)))
          (h/send! host "item" :facts/changed {:baton (assoc m/follow-up-baton :state "closed")})
          (is (= :no-follow-up (m/follow-up-state host)))
          (is (= :merged (m/lane host)))))))
  (testing "Merge Branch while a follow-up waits on the operator merges the build (the v2 bug, N02)"
    (doseq [s [:idle :failed]]
      (let [host (m/place s :follow-up-needs-operator)
            n    (count (h/outbox host "item"))]
        (h/send! host "item" :build/merge op)
        (is (= [{:kind "merge" :session-id "c1"}] (map #(select-keys % [:kind :session-id]) (drop n (h/outbox host "item")))) (name s)))))
  (testing "a held item's follow-up is not closed by the overseer or the operator's act on the item"
    (let [host (m/place :on-hold :follow-up-asking)
          n    (count (h/outbox host "item"))]
      (is (some? (explain host :gather/close (merge l3 {:reason "r"}))))
      (h/send! host "item" :gather/close (merge l3 {:reason "r"}))
      (h/send! host "item" :gather/close (merge op {:reason "r"}))
      (is (= n (count (h/outbox host "item"))))
      (h/send! host "item" :item/resume op)
      (is (= [:drafted :follow-up-asking] [(m/lane host) (m/follow-up-state host)])))))

(deftest a-build-merged-and-still-running
  (testing "a branch merged by hand while its session still works: the item waits in working (mutant M34
            took `landed` without asking `running` and cycled working ⇄ merged)"
    (doseq [s [:working :idle :failed :merged]]
      (let [host (m/place s)]
        (h/send! host "item" :facts/changed {:build (assoc m/build-base :merged true :state "merged" :running true)})
        (is (= :working (m/lane host)) (str (name s) ": merged and running is working"))
        (h/send! host "item" :facts/changed {:build (assoc m/build-base :merged true :state "merged" :running false)})
        (is (= :merged (m/lane host)) (str (name s) ": the turn ends: merged")))))
  (testing "the same with a follow-up live beside it"
    (let [host (m/place :idle :follow-up-asking)]
      (h/send! host "item" :facts/changed {:build (assoc m/build-base :merged true :state "merged" :running true)})
      (is (= [:working :follow-up-asking] [(m/lane host) (m/follow-up-state host)]))))
  (testing "a project root build that runs is working, and merged once it stops"
    (let [host (m/place :idle)]
      (h/send! host "item" :facts/changed {:build (assoc m/build-base :state "root" :running true)})
      (is (= :working (m/lane host)))
      (h/send! host "item" :facts/changed {:build (assoc m/build-base :state "root" :running false)})
      (is (= :merged (m/lane host))))))
