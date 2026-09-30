(ns sova.org-charts.charts.work-item-matrix-test
  "Every (lane state × follow-up state × event) cell of the work-item chart: each atomic lane state
   (and dropped) is reached by a realistic path, with the follow-up region in each of its states
   wherever a follow-up can run; then every event is sent on its own copy, and the resulting lane
   state, follow-up state, attention state and new outbox effects are asserted against the table
   below, under ten envelopes (the operator's click, attended and unattended overseer turns at each
   level, capped, paused, with an empty roster). Every act the chart does not take when sent must
   have a refusal sentence (`explain`), and every act it takes none."
  (:require
    #?(:clj [clojure.test :refer [deftest is testing]] :cljs [cljs.test :refer-macros [deftest is testing]])
    [clojure.string :as str]
    [sova.org-charts.charts.harness :as h]
    [sova.org-charts.charts.work-item :as wi]))

;; ---- fixtures -----------------------------------------------------------------------------------------

(def plenty {:gather {:used 0 :max 6} :promote {:used 0 :max 60} :create {:used 0 :max 4} :prompt {:used 0 :max 12}})
(def room {:gatherings-open 0 :gatherings-cap 5 :coding-running 0 :coding-cap 2})

(def spent {:gather {:used 6 :max 6} :promote {:used 60 :max 60} :create {:used 4 :max 4} :prompt {:used 12 :max 12}})
(def full {:gatherings-open 5 :gatherings-cap 5 :coding-running 2 :coding-cap 2})

(def envelopes
  {:operator    {:by "operator" :attended false :autonomy "L0" :paused false :roster-active true
                 ;; the operator's click takes no allowance: spent limits must not refuse it
                 :allowance spent :at-once full}
   :attended    {:by "overseer" :attended true :autonomy "L0" :paused false :roster-active true :allowance plenty :at-once room}
   :l0          {:by "overseer" :attended false :autonomy "L0" :paused false :roster-active true :allowance plenty :at-once room}
   :l3          {:by "overseer" :attended false :autonomy "L3" :paused false :roster-active true :allowance plenty :at-once room}
   :attended-capped {:by "overseer" :attended true :autonomy "L0" :paused false :roster-active true :allowance spent :at-once full}
   :l3-capped   {:by "overseer" :attended false :autonomy "L3" :paused false :roster-active true :allowance spent :at-once full}
   :l3-paused   {:by "overseer" :attended false :autonomy "L3" :paused true :roster-active true :allowance plenty :at-once room}
   :l3-no-roster {:by "overseer" :attended false :autonomy "L3" :paused false :roster-active false :allowance plenty :at-once room}
   :l2          {:by "overseer" :attended false :autonomy "L2" :paused false :roster-active true :allowance plenty :at-once room}
   :l1          {:by "overseer" :attended false :autonomy "L1" :paused false :roster-active true :allowance plenty :at-once room}})

(def env-keys (keys envelopes))
(def capped-acts #{:gather/start :build/start :build/prompt :decision/promote})
(def rank {"L0" 0 "L1" 1 "L2" 2 "L3" 3})
(def level-in-force {:l0 "L0" :l1 "L1" :l2 "L2" :l3 "L3" :l3-capped "L3" :l3-paused "L0" :l3-no-roster "L0"})

(def baton-open {:id "b1" :state "open" :own true :wrote false :settle false})
(defn decision [state & {:as m}] (merge {:id "d1" :state state :author-owns-area true :name "Ana" :build "not-built"} m))
(def build-base {:session-id "c1" :title "Build it" :running false :last-failed false :merged false :state "open"
                 :started-by "overseer" :live false :workers 0})
(defn promoted [& {:as m}] {:baton (assoc baton-open :state "done") :decisions [(merge (decision "promoted") m)]})

(def gather-args {:to "p1" :public-title "Invoicing" :question "How do you invoice?" :goal "Learn invoicing"})

(def placements
  "How each state is reached: events from a fresh start (acts as the operator)."
  {:open            []
   :gather-starting [[:gather/start gather-args]]
   :asking          [[:facts/changed {:baton baton-open}]]
   :needs-operator  [[:facts/changed {:baton (assoc baton-open :state "needs-you")}]]
   :unreconciled    [[:facts/changed {:baton (assoc baton-open :state "done") :decisions [(decision "pending")]}]]
   :conflicted      [[:facts/changed {:baton (assoc baton-open :state "done") :decisions [(decision "conflict")]}]]
   :drafted         [[:facts/changed {:baton (assoc baton-open :state "done") :decisions [(decision "drafted")]}]]
   :spec-edited     [[:facts/changed (promoted :edited-in-spec true)]]
   :awaiting-build  [[:facts/changed (promoted)]]
   :build-starting  [[:facts/changed (promoted)] [:build/start {:prompt "Build it"}]]
   :working         [[:facts/changed (assoc (promoted) :build (assoc build-base :running true))]]
   :idle            [[:facts/changed (assoc (promoted) :build build-base)]]
   :failed          [[:facts/changed (assoc (promoted) :build (assoc build-base :last-failed true))]]
   :merged          [[:facts/changed (assoc (promoted) :build (assoc build-base :merged true :state "merged"))]]
   :done            [[:facts/changed (assoc (promoted :build "built") :build (assoc build-base :merged true :state "merged"))]]
   :on-hold         [[:facts/changed {:baton baton-open}] [:item/hold {}]]
   :dropped         [[:gap/status {:status "dropped"}]]})

(def rows (conj wi/pipeline-phases :dropped))

(def columns
  "Every event the chart names, with its variants (19)."
  [[:gap/status {:status "dropped"}]
   [:gap/status {:status "done"}]
   [:gap/status {:status "open"}]
   [:gap/status {:status "started"}]
   [:gather/start gather-args]
   [:gather/close {:reason "A newer session covers it"}]
   [:decision/reconcile {}]
   [:decision/promote {:ids ["d1"]}]
   [:decision/settle-text {:action "keep"}]
   [:build/start {:prompt "Build it"}]
   [:build/prompt {:text "Go on"}]
   [:build/merge {}]
   [:item/hold {}]
   [:item/resume {}]
   [:facts/changed {}]
   [:effect/failed {:kind "start-gathering"}]
   [:effect/failed {:kind "start-coding"}]
   [:item/stalled :current]
   [:item/moved {}]])

(def fu-states
  "The follow-up region's states, in document order."
  [:no-follow-up :follow-up-starting :follow-up-asking :follow-up-needs-operator])

(defn column-name [[ev d]] (str (namespace ev) "/" (name ev) (when (and (map? d) (or (:status d) (:kind d))) (str ":" (or (:status d) (:kind d))))))

;; ---- the expected table (operator's click) ------------------------------------------------------------
;; Outcome per cell: `-` nothing changes; `[:to x]` the lane moves to x; `[:fx k]` exactly one new
;; effect, of kind k (`[:fx [k1 k2]]` for several); `[:fu f]` the follow-up region moves to f; any of
;; these together in that order (`[:to x :fx k :fu f]`); `:stalled` the attention region stalls.

(def no :-)
(def all-dash (vec (repeat 19 no)))

(defn row
  "A row: dashes, with `overrides` {column-index outcome}."
  [overrides]
  (reduce-kv assoc all-dash overrides))

;; column indexes
(def c-drop 0) (def c-done 1) (def c-open 2) (def c-started 3) (def c-gather 4) (def c-close 5)
(def c-reconcile 6) (def c-promote 7) (def c-settle 8) (def c-build 9) (def c-prompt 10) (def c-merge 11)
(def c-hold 12) (def c-resume 13) (def c-facts 14) (def c-failed-g 15) (def c-failed-c 16) (def c-stalled 17) (def c-moved 18)

(defn pipeline-row
  "A pipeline phase: drop, close and hold always apply; a stall clock stalls it."
  [phase overrides]
  (row (merge {c-drop    [:to :dropped :fx "idea-status"]
               c-done    [:fx "idea-status"]
               c-open    [:fx "idea-status"]
               c-started [:fx "idea-status"]
               c-hold    [:to :on-hold]
               c-reconcile [:fx "reconcile"]
               c-stalled (if (contains? wi/stall-phases phase) :stalled no)}
         overrides)))

(def regather {c-gather [:to :gather-starting :fx "start-gathering"]})
(def follow-up {c-gather [:fx "start-gathering" :fu :follow-up-starting]})
(def deciding follow-up)

(def expected
  {:open            (pipeline-row :open {c-gather [:to :gather-starting :fx "start-gathering"]})
   :gather-starting (pipeline-row :gather-starting {c-failed-g [:to :open]})
   :asking          (pipeline-row :asking (merge regather {c-close [:fx "close-gathering"]}))
   :needs-operator  (pipeline-row :needs-operator (merge regather {c-close [:fx "close-gathering"]}))
   :unreconciled    (pipeline-row :unreconciled deciding)
   :conflicted      (pipeline-row :conflicted deciding)
   :drafted         (pipeline-row :drafted (merge deciding {c-promote [:fx "promote"]}))
   :spec-edited     (pipeline-row :spec-edited (merge deciding {c-settle [:fx "settle-text"]}))
   :awaiting-build  (pipeline-row :awaiting-build (merge follow-up {c-build [:to :build-starting :fx "start-coding"]}))
   :build-starting  (pipeline-row :build-starting (merge follow-up {c-failed-c [:to :awaiting-build]}))
   :working         (pipeline-row :working (merge follow-up {c-prompt [:fx "prompt"]}))
   :idle            (pipeline-row :idle (merge follow-up {c-prompt [:fx "prompt"] c-merge [:fx "merge"]}))
   :failed          (pipeline-row :failed (merge follow-up {c-prompt [:fx "prompt"] c-merge [:fx "merge"]}))
   :merged          (pipeline-row :merged (merge follow-up {c-build [:to :build-starting :fx "start-coding"]}))
   :done            (pipeline-row :done follow-up)
   :on-hold         (row {c-drop [:to :dropped :fx "idea-status"] c-done [:fx "idea-status"] c-open [:fx "idea-status"]
                          c-started [:fx "idea-status"] c-resume [:to :asking]})
   :dropped         all-dash})

(def operator-only #{:decision/settle-text :build/merge :item/hold :item/resume})
(def level-of {:gap/status "L0" :gather/start "L1" :gather/close "L1" :decision/reconcile "L1"
               :decision/promote "L2" :build/start "L3" :build/prompt "L3"})

(def follow-up-rows
  "Every lane state a follow-up can start in (deciding or promoted)."
  [:unreconciled :conflicted :drafted :spec-edited :awaiting-build :build-starting
   :working :idle :failed :merged :done])

(def follow-up-axis
  "Where the follow-up region is enumerated: every lane state a follow-up runs beside, and a held or
   dropped item that had one (held and dropped from :drafted)."
  (conj follow-up-rows :on-hold :dropped))

(defn fu-row
  "`state`'s row with the follow-up region in `fu`: the follow-up's own acts and host events apply
   beside the lane, which is unchanged. On hold (held from :drafted), only resume and the idea status
   apply, and a failed start still ends the follow-up; resume goes back to :drafted."
  [state fu]
  (let [base (expected state)]
    (case state
      :dropped all-dash
      :on-hold (cond-> (assoc base c-resume [:to :drafted])
                 (= fu :follow-up-starting) (assoc c-failed-g [:fu :no-follow-up]))
      (case fu
        :no-follow-up base
        :follow-up-starting (assoc base c-gather no c-failed-g [:fu :no-follow-up])
        (:follow-up-asking :follow-up-needs-operator)
        (assoc base c-gather [:fx "start-gathering" :fu :follow-up-starting] c-close [:fx "close-gathering"])))))

(defn expected-for
  "The table under another envelope: the overseer never takes an operator-only act; unattended it
   takes only acts at or under the level in force (paused or an empty roster force L0); with its
   limits spent it takes none that counts against them."
  ([env-key state col] (expected-for env-key state :no-follow-up col))
  ([env-key state fu col]
  (let [[ev] (nth columns col)
        out  (if (= fu :no-follow-up) (get-in expected [state col]) (nth (fu-row state fu) col))
        lvl  (level-in-force env-key)]
    (cond
      (= env-key :operator) out
      (operator-only ev) no
      (and lvl (level-of ev) (> (rank (level-of ev)) (rank lvl))) no
      (and (#{:attended-capped :l3-capped} env-key) (capped-acts ev)) no
      :else out))))

;; ---- running a cell ---------------------------------------------------------------------------------------

(def follow-up-baton (assoc baton-open :id "b2"))

(def fu-placements
  "How the follow-up region reaches each state once the lane is placed (acts as the operator)."
  {:no-follow-up             []
   :follow-up-starting       [[:gather/start gather-args]]
   :follow-up-asking         [[:gather/start gather-args] [:facts/changed {:baton follow-up-baton}]]
   :follow-up-needs-operator [[:gather/start gather-args] [:facts/changed {:baton (assoc follow-up-baton :state "needs-you")}]]})

(defn place*
  [state fu]
   (let [host  (h/new-host)
         lane0 (if (and (not= fu :no-follow-up) (#{:on-hold :dropped} state)) :drafted state)]
     (h/start! host :work-item "item" {:item-id "§gap/invoicing" :project-sid "project"})
     (h/start! host :project "project" {:project-sid "project" :roster-active true})
     (doseq [[ev d] (concat (placements lane0) (fu-placements fu)
                      (when (not= lane0 state) [(last (placements state))]))]
       (h/send! host "item" ev (merge (:operator envelopes) d)))
     host))

(def placed (memoize place*))

(defn place
  "A fresh host with the item in `state` (and its follow-up in `fu`): a fork of one placement."
  ([state] (place state :no-follow-up))
  ([state fu] (h/fork (placed state fu))))

(defn lane [host] (if (h/running? host "item") (wi/phase (h/config host "item")) :dropped))

(defn follow-up-state [host]
  (some #(when (h/in? host "item" %) %) fu-states))

(defn outcome
  "What sending the column's event did: -, :stalled, or [:to x :fx k :fu f] (the parts that happened)."
  [host state [ev d] env]
  (let [before-fx (count (h/outbox host "item"))
        before    (lane host)
        fu-before (follow-up-state host)
        d         (if (= :current d) {:phase (name state)} d)
        _         (h/send! host "item" ev (merge env d))
        after     (lane host)
        fu-after  (follow-up-state host)
        fx        (drop before-fx (h/outbox host "item"))
        stalled?  (and (h/running? host "item") (h/in? host "item" :stalled))]
    (cond
      stalled? :stalled
      :else (let [v (cond-> []
                      (not= before after) (conj :to after)
                      (seq fx) (conj :fx (if (= 1 (count fx)) (:kind (first fx)) (mapv :kind fx)))
                      (and fu-after (not= fu-before fu-after)) (conj :fu fu-after))]
              (if (empty? v) no v)))))

(defn explain-now [host ev env]
  (wi/explain {:config (h/config host "item") :data (h/data host "item") :running? (h/running? host "item")} ev env))

(defn cells
  "Every (envelope, lane state, follow-up state, column) cell."
  []
  (for [env-key env-keys
        s       rows
        fu      (if (some #{s} follow-up-axis) fu-states [:no-follow-up])
        col     (range (count columns))]
    [env-key s fu col]))

(defn cell-name [env-key s fu col]
  (str (name env-key) " · " (name s) (when (not= fu :no-follow-up) (str " + " (name fu))) " × " (column-name (nth columns col))))

(deftest placements-reach-their-states
  (doseq [s rows]
    (is (= s (lane (place s))) (str "placement of " s)))
  (doseq [s follow-up-axis
          fu fu-states]
    (let [host (place s fu)]
      (is (= [s (when-not (= s :dropped) fu)] [(lane host) (follow-up-state host)]) (str "placement of " s " + " fu)))))

(deftest every-state-x-event-cell
  (doseq [[env-key s fu col] (cells)]
    (let [host (place s fu)
          got  (outcome host s (nth columns col) (envelopes env-key))
          want (expected-for env-key s fu col)]
      (is (= want got) (cell-name env-key s fu col)))))

(deftest acts-not-taken-have-a-refusal-and-taken-ones-none
  (testing "each act is SENT: the chart's result (anything moved or emitted) agrees with explain, and with the table"
    (doseq [[env-key s fu col] (cells)
            :let [[ev d] (nth columns col)]
            :when (some #{ev} wi/acts)]
      (let [host  (place s fu)
            env   (merge (envelopes env-key) d)
            why   (explain-now host ev env)
            got   (outcome host s [ev d] (envelopes env-key))
            taken (not= no got)]
        (is (= taken (not= no (expected-for env-key s fu col))) (str (cell-name env-key s fu col) ": the table"))
        (if taken
          (is (nil? why) (str (cell-name env-key s fu col) " taken, but explain refuses: " why))
          (is (string? why) (str (cell-name env-key s fu col) " not taken, but explain has no refusal")))))))

(deftest l0-refusals-are-todays-sentences
  (let [host (place :drafted)
        why  (wi/explain {:config (h/config host "item") :data (h/data host "item") :running? true}
               :decision/promote (merge (:l0 envelopes) {:ids ["d1"]}))]
    (is (= (str "This run was not started by the operator, and your autonomy here is L0; sova_promote needs L2. "
             "Do not retry it. File what you would do as an idea (sova_idea, tag gap) or raise a sova_card card that says what and why; "
             "the operator's click starts a turn in which you may act.")
          why)))
  (let [host (place :open)
        why  (wi/explain {:config (h/config host "item") :data (h/data host "item") :running? true}
               :gather/start (merge (:l0 envelopes) {:paused true :autonomy "L3"} gather-args))]
    (is (str/includes? why "your autonomy here is L0 (Paused at L0: this organization was attached on this host. Set its level to resume.); sova_start_gathering needs L1."))))

;; ---- every (state × fact change) cell ---------------------------------------------------------------------
;; facts/changed carries the item's position; each column is one kind of store change, applied on
;; top of the state's own facts (a key it names replaces that fact).

(def done-baton (assoc baton-open :state "done"))
(def prom [(decision "promoted")])

(def fact-columns
  [[:baton-open      {:baton baton-open}]
   [:baton-needs-you {:baton (assoc baton-open :state "needs-you")}]
   [:done-nothing    {:baton done-baton :decisions []}]
   [:closed-nothing  {:baton (assoc baton-open :state "closed") :decisions []}]
   [:done-pending    {:baton done-baton :decisions [(decision "pending")]}]
   [:conflict        {:decisions [(decision "conflict")]}]
   [:drafted         {:decisions [(decision "drafted")]}]
   [:promoted-nobuild {:decisions prom :build nil}]
   [:edited          {:decisions [(decision "promoted" :edited-in-spec true)]}]
   [:superseded      {:decisions [(decision "superseded")]}]
   [:running         {:decisions prom :build (assoc build-base :running true)}]
   [:idle            {:decisions prom :build build-base}]
   [:failed          {:decisions prom :build (assoc build-base :last-failed true)}]
   [:merged          {:decisions prom :build (assoc build-base :merged true :state "merged")}]
   [:merged-built    {:decisions [(decision "promoted" :build "built")] :build (assoc build-base :merged true :state "merged")}]
   [:baton-gone      {:baton nil}]])

(def fact-cols (mapv first fact-columns))

(defn frow
  "`base` for every column, with `overrides` {column outcome}."
  [base overrides]
  (mapv #(get overrides % base) fact-cols))

(def to-build
  "Where a promoted item goes for each build fact."
  {:running :working :idle :idle :failed :failed :merged :merged :merged-built :done})

(def deciding-cols
  {:done-pending :unreconciled :conflict :conflicted :drafted :drafted :promoted-nobuild :awaiting-build :edited :spec-edited})

(defn deciding-row [self]
  (frow self (merge (dissoc (merge deciding-cols to-build) self) {})))

(defn promoted-row [self overrides]
  (frow self (merge (select-keys deciding-cols [:done-pending :conflict :drafted :edited]) to-build overrides)))

(def expected-facts
  {:open            (frow :open (merge {:baton-open :asking :baton-needs-you :needs-operator} deciding-cols to-build))
   :gather-starting (frow :gather-starting {:baton-open :asking :baton-needs-you :needs-operator :done-nothing :open
                                            :closed-nothing :open :done-pending :unreconciled})
   :asking          (frow :asking {:baton-needs-you :needs-operator :done-nothing :open :closed-nothing :open
                                   :done-pending :unreconciled :baton-gone :open})
   :needs-operator  (frow :needs-operator {:baton-open :asking :done-nothing :open :closed-nothing :open
                                           :done-pending :unreconciled :baton-gone :open})
   :unreconciled    (deciding-row :unreconciled)
   :conflicted      (deciding-row :conflicted)
   :drafted         (deciding-row :drafted)
   :spec-edited     (deciding-row :spec-edited)
   :awaiting-build  (promoted-row :awaiting-build {:promoted-nobuild :awaiting-build})
   :build-starting  (promoted-row :build-starting {:promoted-nobuild :build-starting})
   :working         (promoted-row :working {:promoted-nobuild :idle})
   :idle            (promoted-row :idle {:promoted-nobuild :idle})
   :failed          (promoted-row :failed {:promoted-nobuild :idle})
   :merged          (promoted-row :merged {:promoted-nobuild :merged})
   :done            (promoted-row :done {:promoted-nobuild :merged :done-nothing :merged :closed-nothing :merged
                                         :superseded :merged})
   :on-hold         (frow :on-hold {})
   :dropped         (frow :dropped {})})

(deftest every-state-x-fact-change-cell
  (doseq [s rows
          [col d] fact-columns]
    (let [host (place s)]
      (h/send! host "item" :facts/changed d)
      (is (= (get (zipmap fact-cols (expected-facts s)) col) (lane host))
        (str (name s) " × facts " (name col))))))

(deftest resume-after-hold-re-derives-from-facts
  (testing "facts that change while on hold move the item once it resumes (deep history, then eventless)"
    (let [host (place :on-hold)]
      (h/send! host "item" :facts/changed {:baton done-baton :decisions [(decision "drafted")]})
      (is (= :on-hold (lane host)))
      (h/send! host "item" :item/resume (:operator envelopes))
      (is (= :drafted (lane host)))))
  (testing "resume returns to the exact deep state"
    (let [host (place :failed)]
      (h/send! host "item" :item/hold (:operator envelopes))
      (h/send! host "item" :item/resume (:operator envelopes))
      (is (= :failed (lane host))))))

;; ---- every (state × fact change) cell with a follow-up gathering live ---------------------------------
;; A build can land, and decisions can move, while a follow-up gathering waits on the operator: the
;; lane goes exactly where it goes without one (the table above), and the follow-up stays live
;; unless a baton fact ends or replaces it.

(deftest every-state-x-fact-change-with-a-follow-up-live
  (doseq [fu [:follow-up-asking :follow-up-needs-operator]
          s  follow-up-rows
          [col d] fact-columns]
    (let [host (place s fu)]
      (is (= [s fu] [(lane host) (follow-up-state host)]) (str (name s) " with a follow-up"))
      ;; a baton column is about the first baton: here it is the follow-up's (a later id)
      (h/send! host "item" :facts/changed (cond-> d (:baton d) (assoc-in [:baton :id] "b2")))
      (is (= (get (zipmap fact-cols (expected-facts s)) col) (lane host))
        (str (name s) " + " (name fu) " × facts " (name col) ": the lane is as without a follow-up"))
      (is (= (case col
               (:baton-open) :follow-up-asking
               (:baton-needs-you) :follow-up-needs-operator
               (:done-nothing :closed-nothing :done-pending :baton-gone) :no-follow-up
               fu)
            (follow-up-state host))
        (str (name s) " + " (name fu) " × facts " (name col) ": the follow-up")))))

(deftest landed-while-gathering
  (doseq [s [:working :idle :failed]]
    (let [host (place s)]
      (h/send! host "item" :gather/start (merge (:operator envelopes) gather-args))
      (h/send! host "item" :facts/changed {:baton (assoc baton-open :id "b2" :state "needs-you")})
      (h/send! host "item" :facts/changed {:build (assoc build-base :merged true :state "merged")})
      (is (= [:merged :follow-up-needs-operator] [(lane host) (follow-up-state host)]) (name s))
      (h/send! host "item" :facts/changed {:decisions [(decision "promoted" :build "built")]})
      (is (= [:done :follow-up-needs-operator] [(lane host) (follow-up-state host)]) (name s)))))
