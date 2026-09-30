(ns sova.org-charts.charts.reasons
  "Typed reasons to look: one kind per `noteReason` call site in server/project-overseer.ts and
   server/project-overseer-tools.ts (held items), plus the kinds only work items send. Each kind
   renders today's English sentence, and says whether it is a reason to look soon and whether it is
   one of the overseer's own acts (today's `soon` and `own` arguments)."
  (:require
    [sova.org-charts.charts.base :as b]))

(defn- plural [n one many] (if (= n 1) one many))

(def do-what
  {"gather" "start gathering sessions" "promote" "promote decisions"
   "create" "start coding sessions" "prompt" "prompt coding sessions"})

(defn- promoted-by-operator? [{:keys [by n]}]
  (and (some? by) (not= by "overseer") (pos? (or n 0))))

(defn text
  "Today's sentence for a reason `{:kind :params}`, or its own `:text` when it carries one."
  [{:keys [kind params] :as r}]
  (or (:text r)
      (let [{:keys [title n question failed branch target reason what at item phase since]} params
            n (or n (count (:ids params)))]
        (case kind
          "baton/done" (str "The gathering session \"" title "\" reached its goal.")
          "baton/closed" (str "The gathering session \"" title "\" was closed.")
          "baton/proposal" (str "Someone was referred in \"" title "\" (a proposed roster person).")
          "baton/asked-operator" (str "The gathering session \"" title "\" handed a question to the operator (their words, as data): \"" (or question "") "\"")
          "reconcile/conflict" (str n " new conflict" (plural n "" "s") " between decisions.")
          "reconcile/resolved" (str n " conflict" (plural n " was" "s were") " resolved.")
          "reconcile/promoted" (if (promoted-by-operator? (assoc params :n n))
                                 (str "The operator promoted " n " decision" (plural n "" "s") " into the spec.")
                                 (str n " decision" (plural n " was" "s were") " promoted into the spec."))
          "reconcile/drafted" (str n " decision" (plural n " is" "s are") " drafted and promotable.")
          "coding/settled" (str "The coding session \"" title "\" " (if failed "stopped with an error" "finished its turn") ".")
          "build/not-prompted" (str "The coding session \"" title "\" started, but its mode could not be set, so its first prompt was not sent.")
          "build/merged" (str "The operator merged \"" title "\" (" branch ") into " target ".")
          "build/merge-refused" (str "Merge Branch for \"" title "\" was refused: " reason)
          "held/looks" (str "Today's looks are back (refused " (b/clock-time at) ").")
          "held/day" (str "Today's allowance is back: it may " (do-what (:kind params)) " again (refused " (b/clock-time at) ").")
          "held/message" (str "The operator's last message reached its limit on " what "; it may go on within today's allowance.")
          "held/raised" (str "You raised the limit on " what ".")
          "item/stalled" (str "The gap " item " has waited in " phase " since " (b/clock-time since) ".")
          "item/answered-nothing" (str "The gathering session for " item " ended with no decision.")
          "item/reopened" (str "A newer decision reopened " item ".")
          "item/built" (str item " is built: merged, and every decision it rests on is built per the spec.")
          "hold/review" (str what " waits for your review (hold " (or (:hold params) (:id params)) "): approve it, or cancel it with a reason. It does not go ahead until you do.")
          (str kind)))))

(def soon-kinds
  #{"baton/done" "baton/asked-operator" "coding/settled" "build/not-prompted" "build/merged" "build/merge-refused"
    "held/looks" "held/day" "held/raised" "item/stalled" "hold/review"})

(defn soon?
  "A reason to look soon (today's `soon` argument)."
  [{:keys [kind params]}]
  (or (contains? soon-kinds kind)
      (and (= kind "reconcile/promoted") (promoted-by-operator? (assoc params :n (or (:n params) (count (:ids params))))))))

(def own-kinds #{"reconcile/conflict" "reconcile/resolved" "reconcile/drafted"})

(defn own?
  "One of the reconciler's events, which while the overseer runs are its own acts (today's `own`)."
  [{:keys [kind params]}]
  (or (contains? own-kinds kind)
      (and (= kind "reconcile/promoted") (not (promoted-by-operator? (assoc params :n (or (:n params) (count (:ids params)))))))))

(defn dedupe-key
  "withReason dedupes by exact text; a reason may carry its own `:key` (typed identity)."
  [r]
  (or (:key r) (text r)))
