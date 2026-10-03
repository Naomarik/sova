(ns sova.statecharts.org
  "The org statechart (portable, `org/<org>`): the organization's identity, its owner (§app.owner-page/owner),
   the holder record (r1: the holder lives in this snapshot, so the clone and origin name it), and
   the births of its people and its projects' placements.

   About (`about.md`, `org-history.jsonl`) is plain data with today's rules, written by its route:
   it never enters a statechart (§app.organizations/about's one-reader rule stays structural).

   Owner ‹none · set · cleared›: the operator sets it (an active person) and clears it; the person
   leaving clears it (`link/moved` of the watched owner showing `:left`), with `ownerCleared`, and
   turns the owner link off. Every change turns the previous owner's link off.

   Start data: `{:id :name :slug :created-at :holder {:host-id :host-name :since}}`."
  (:require
    [clojure.string :as str]
    [com.fulcrologic.statecharts.chart :as chart]
    [com.fulcrologic.statecharts.elements :refer [state transition on-entry script]]
    [com.fulcrologic.statecharts.data-model.operations :as ops]
    [sova.statecharts.base :as b]
    [sova.statecharts.person :as person]
    [sova.statecharts.rules.hours :as hours]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.rules.person :as rp]
    [sova.statecharts.rules.refusal :as r]
    [sova.statecharts.engine.dsl :as dsl]))

(def version 1)
(def history-max 50)
(def name-max 80)

;; ---- checks -------------------------------------------------------------------------------------

(defn name-check
  "The org's name: 1–80 characters."
  [data]
  (let [n (str/trim (or (:name (b/evt data)) ""))]
    (when (or (= "" n) (> (count n) name-max)) (r/refuse 400 (str "name must be 1–" name-max " characters")))))

(def invalid (lv/invalid-check b/evt))

(defn owner-target-check
  "owner/set: null (no owner), or an active person (the host stamps `target {id name status}`)."
  [data]
  (let [e (b/evt data)]
    (when (some? (:person-id e))
      (when-not (= "active" (get-in e [:target :status]))
        (r/refuse 400 "Only an active person on the roster can be the owner.")))))

(defn same-owner? [_ data] (= (:person-id (b/evt data)) (:owner data)))

(defn person-add-change
  "person/add: the new person as the roster writer would store it, or a refusal."
  [data]
  (let [e (b/evt data)]
    (rp/apply-change nil (:person e) (or (some-> (:by-kind e) name) "operator") (:names-taken e))))

(defn person-add-check [data] (let [c (person-add-change data)] (when (r/refusal? c) c)))

(defn- by-of
  "The creation's `by`, as person/edit records it: a referral's creation lines say referral (with its
   session, entry and quote), which reconcile's decidesTrusted relies on."
  [data]
  (person/change-by data))

;; ---- owner ----------------------------------------------------------------------------------------

(defn- history-row [data from to why]
  (cond-> {:at (b/now-ms data) :from from :to to :why why}
    (= "overseer" (some-> (:via (b/evt data)) name)) (assoc :via "overseer")))

(defn- push-history [data row]
  (vec (take-last history-max (conj (vec (:owner-history data)) row))))

(defn set-owner-ops [data]
  (let [to (:person-id (b/evt data))]
    [(ops/assign :owner-history (push-history data (history-row data (:owner data) to "operator")))
     (ops/assign :owner to)
     (ops/delete :owner-cleared)]))

(defn owner-left? [_ data]
  (and (= (:owner data) (b/last-part (:from (b/moved data))))
       (= "person" (:statechart (b/moved data)))
       (b/moved-in? data :left)))

(defn clear-owner-ops [data]
  (let [pid (:owner data)]
    [(ops/assign :owner-history (push-history data {:at (b/now-ms data) :from pid :to nil :why "left"}))
     (ops/assign :owner nil)
     (ops/assign :owner-cleared {:person-id pid :name (get-in (b/moved data) [:exported :name]) :at (b/now-ms data)})]))

(defn- revoke-owner-links [why]
  (dsl/effect :revoke-owner-links (fn [_] {:why why})))

(defn- owner-set-act [target-state]
  (dsl/act {:sova/feed :feed :event :owner/set :target target-state
            :checks [invalid owner-target-check]
            :cond (fn [env d] (and (not (same-owner? env d))
                                   (= (some? (:person-id (b/evt d))) (= target-state :owner-set))))}
    (revoke-owner-links "owner-changed")
    (b/relink (fn [d] (some->> (:owner d) (b/person-sid (:id d))))
              (fn [d] (some->> (:person-id (b/evt d)) (b/person-sid (:id d)))))
    (script {:expr (fn [_ d] (set-owner-ops d))})))

(defn- owner-transitions []
  [;; the same person again writes nothing (and is no refusal)
   (dsl/act {:sova/feed :feed :event :owner/set :checks [invalid owner-target-check] :cond same-owner?})
   (owner-set-act :owner-set)
   (owner-set-act :owner-none)])

;; ---- company hours (r13) -------------------------------------------------------------------------------

(defn hours-check
  "The company's zone and hours: the operator's, validated as a person's (same sentences)."
  [d]
  (let [e (b/evt d)]
    (cond
      (not (b/operator-act? d)) (r/refuse 403 "Only the operator sets the company's working hours.")
      (and (contains? e :tz) (hours/tz-problem (:tz e))) (r/refuse 400 (hours/tz-problem (:tz e)))
      (and (contains? e :hours) (hours/hours-problem (:hours e))) (r/refuse 400 (hours/hours-problem (:hours e))))))

(defn hours-ops
  "Set (or, with null / \"\", clear) what the event names; people without hours of their own use them."
  [d]
  (let [e (b/evt d)]
    (cond-> []
      (contains? e :tz) (conj (ops/assign :tz (when-not (str/blank? (:tz e)) (:tz e))))
      (contains? e :hours) (conj (ops/assign :hours (:hours e))))))

;; ---- births -------------------------------------------------------------------------------------------

(defn placement-data
  "A project placed in the organization (born here, or imported): the placement's start data."
  [data]
  (let [e (b/evt data)]
    {:org-id (:id data) :project-id (:project-id e) :via (or (some-> (:placed-via e) name) "born")
     :placed-at (b/now-ms data)}))

(def statechart
  (chart/statechart {:initial :org}
    (state {:id :org :initial :owner-none}
      (dsl/hold-cancel-correction)

      (dsl/act {:sova/feed :feed :event :org/rename :checks [name-check]}
        (script {:expr (fn [_ d] [(ops/assign :name (str/trim (:name (b/evt d))))])}))

      ;; r13: the company's working hours (exported: its people's default, read by their statecharts)
      (dsl/act {:sova/feed :feed :event :org/hours :checks [invalid hours-check]}
        (script {:expr (fn [_ d] (hours-ops d))}))

      ;; A project placed here: its own sessions (project/<p>, born or imported) live in this engine;
      ;; the org's concerns for it live in its placement. The host stamps why it can't be placed as
      ;; `invalid`. Placing a placed project again is a no-op (the org-open invariant places any
      ;; project session that has no placement).
      (dsl/act {:sova/feed :feed :event :project/place :checks [invalid]}
        (dsl/spawn {:statechart "placement" :link :org :watch? false :if-exists :skip
                    :id (fn [d] (b/placement-sid (:id d) (:project-id (b/evt d)))) :data placement-data}))

      ;; A person, added by the operator (or the global Overseer for them): active from the start.
      (dsl/act {:sova/feed :feed :event :person/add :checks [invalid person-add-check]}
        (dsl/spawn {:statechart "person" :link :org :watch? false
                    :id   (fn [d] (b/person-sid (:id d) (:person-id (b/evt d))))
                    :data (fn [d] (let [{:keys [person changed]} (person-add-change d)]
                                    {:org-id (:id d) :id (:person-id (b/evt d)) :person person :changed changed :by (by-of d)}))}))

      ;; The holder record (r1): written by this host's residence at create, attach and detach.
      (transition {:sova/feed :quiet :event :holder/claim}
        (script {:expr (fn [_ d] [(ops/assign :holder (select-keys (b/evt d) [:host-id :host-name :since]))])}))
      (transition {:sova/feed :quiet :event :holder/release}
        (script {:expr (fn [_ d] [(ops/assign :holder (merge (:holder d) {:released-by (:host-id (b/evt d)) :released-at (b/now-ms d)}))])}))

      (state {:id :owner-none}
        (transition {:sova/feed :feed :cond (fn [_ d] (some? (:owner d))) :target :owner-set})
        (owner-transitions))
      (state {:id :owner-set}
        (transition {:sova/feed :feed :event :link/moved :cond owner-left? :target :owner-cleared}
          (revoke-owner-links "left")
          (script {:expr (fn [_ d] (clear-owner-ops d))}))
        (owner-transitions))
      ;; The People tab's Owner card says so until the operator picks someone or None.
      (state {:id :owner-cleared}
        (dsl/act {:sova/feed :feed :event :owner/set :target :owner-none :checks [invalid owner-target-check]
                  :cond (fn [_ d] (nil? (:person-id (b/evt d))))}
          (script {:expr (fn [_ d] (set-owner-ops d))}))
        (owner-transitions)))))

(def acts
  {:org/rename   {:needs nil}
   :org/hours    {:needs nil}
   :project/place {:needs nil}
   :person/add   {:needs nil}
   :owner/set    {:needs nil}
   :hold/cancel  {:needs "L0" :correction true}})

(defn not-here [_event _config _data] "That can't be done now.")

(def entry
  {:statechart    statechart
   :version  version
   :migrate  {}
   :storage  :portable
   :exported [:name :owner :owner-cleared :holder :tz :hours]
   :acts     acts
   :not-here not-here})
