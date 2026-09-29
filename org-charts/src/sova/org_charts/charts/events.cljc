(ns sova.org-charts.charts.events
  "The event vocabulary of both charts as malli schemas (EVENTS.md is the reading copy).

   `schemas` per chart maps each event to the schema of its data (envelope + payload, as the chart
   sees it: kebab keys, string values). `candidates` lists the acts an LLM or the operator may fire;
   the engine's enabledEvents trials each against the current configuration and envelope."
  (:require
    [malli.core :as m]
    [malli.error :as me]
    [sova.org-charts.charts.project :as project]
    [sova.org-charts.charts.work-item :as work-item]))

(def level [:enum "L0" "L1" "L2" "L3"])
(def allowance [:map [:used {:optional true} :int] [:max {:optional true} [:maybe :int]]])

(def envelope
  "What the host stamps on every act (autonomyRefusal's inputs, the caps)."
  [:map
   [:at {:optional true} number?]
   [:by {:optional true} [:enum "overseer" "operator" "system"]]
   [:attended {:optional true} :boolean]
   [:autonomy {:optional true} level]
   [:paused {:optional true} :boolean]
   [:roster-active {:optional true} :boolean]
   [:allowance {:optional true} [:map-of :keyword allowance]]
   [:invalid {:optional true} :string]
   [:at-once {:optional true} [:map
                               [:gatherings-open {:optional true} :int] [:gatherings-cap {:optional true} :int]
                               [:coding-running {:optional true} :int] [:coding-cap {:optional true} :int]]]])

(defn act [& entries] (into envelope entries))

(def baton [:maybe [:map [:id :string] [:state [:enum "open" "needs-you" "done" "closed"]]
                    [:wrote {:optional true} :boolean] [:own {:optional true} :boolean] [:settle {:optional true} :boolean]]])
(def decision [:map [:id :string] [:state [:enum "pending" "drafted" "conflict" "promoted" "superseded"]]
               [:author-owns-area {:optional true} :boolean] [:edited-in-spec {:optional true} :boolean]
               [:build {:optional true} [:maybe [:enum "built" "not-built"]]] [:name {:optional true} :string]])
(def build [:maybe [:map [:session-id :string] [:title {:optional true} :string]
                    [:running {:optional true} :boolean] [:last-failed {:optional true} :boolean]
                    [:merged {:optional true} :boolean] [:new-since-merge {:optional true} :int]
                    [:state {:optional true} [:enum "open" "merged" "removed" "missing" "root"]]
                    [:started-by {:optional true} [:enum "overseer" "operator"]]
                    [:live {:optional true} :boolean] [:workers {:optional true} :int]]])

(def work-item-schemas
  {:gap/status           (act [:status [:enum "open" "exploring" "started" "done" "dropped"]])
   :gather/start         (act [:to [:or :string [:vector :string]]] [:public-title :string] [:question :string] [:goal :string])
   :gather/close         (act [:reason {:optional true} :string])
   :decision/reconcile   envelope
   :decision/promote     (act [:ids [:vector :string]] [:bulk {:optional true} :boolean])
   :decision/settle-text (act [:action [:enum "keep" "restore"]])
   :build/start          (act [:prompt {:optional true} :string] [:title {:optional true} :string])
   :build/prompt         (act [:text :string])
   :build/merge          envelope
   :item/hold            envelope
   :item/resume          envelope
   :facts/changed        [:map [:at {:optional true} number?] [:baton {:optional true} baton]
                          [:decisions {:optional true} [:vector decision]] [:build {:optional true} build]]
   :effect/failed        [:map [:at {:optional true} number?] [:kind :string] [:key {:optional true} :string] [:detail {:optional true} :string]]
   :item/stalled         [:map [:phase :string] [:since {:optional true} number?]]
   :item/moved           [:map]})

(def reason
  [:map [:kind :string] [:params {:optional true} :map] [:text {:optional true} :string]
   [:key {:optional true} :string] [:by {:optional true} :string] [:at {:optional true} number?]])

(def project-schemas
  {:reason/noted        [:or reason [:map [:reasons [:vector reason]] [:by {:optional true} :string]]]
   :overseer/busy       [:map]
   :overseer/idle       [:map]
   :operator/run-now    envelope
   :operator/level-set  (act [:autonomy level])
   :settings/changed    [:map [:watch {:optional true} :boolean] [:watch-gap-min {:optional true} :int]
                         [:soon-look-sec {:optional true} [:maybe :int]] [:autonomy {:optional true} level]
                         [:caps {:optional true} [:map-of :keyword [:maybe :int]]]]
   :look/finished       [:map]
   :look/stopped        [:map [:detail {:optional true} :string]]
   :look/not-started    [:map [:detail {:optional true} :string]]
   :sova/resumed        [:map]
   :org/attached-here   [:map]
   :project/archived    [:map]
   :project/unarchived  [:map]
   :limit/refused       [:map [:ledger [:enum "day" "message"]] [:kind [:enum "gather" "promote" "create" "prompt"]]
                         [:used :int] [:max :int]]
   :facts/changed       [:map [:roster-active {:optional true} :boolean] [:streaming {:optional true} :boolean]
                         [:queued {:optional true} :int]]
   :overseer/act        (act [:tool :string] [:op {:optional true} :string] [:n {:optional true} :int])
   :watch/due           [:map]
   :day/rollover        [:map]})

(def schemas {:work-item work-item-schemas :project project-schemas})

(def candidates
  "The acts per chart (what enabledEvents trials)."
  {:work-item work-item/acts :project project/acts})

(defn problems
  "Why `data` does not fit `event`'s schema on `chart` (humanized), or nil. An unknown event is a problem."
  [chart event data]
  (if-let [s (get-in schemas [chart event])]
    (some-> (m/explain s data) me/humanize)
    {:event [(str "not an event of the " (name chart) " chart")]}))
