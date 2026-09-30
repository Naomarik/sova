(ns sova.org-charts.charts.rules.baton
  "The baton chart's rules, pure over its data and the event (server/baton.ts moveRefusal,
   offerRefusal, noteMessage, extendBudget; baton-loadout.ts hand_to, goal_done, record_decision,
   propose_roster_edit; project-overseer-tools.ts sova_close_gathering; wrapup-routes.ts). Every
   sentence is today's."
  (:require
    [clojure.string :as str]
    [sova.org-charts.charts.rules.reach :as reach]
    [sova.org-charts.charts.rules.refusal :as r]))

(def operator "operator")
(def pool "pool")
(def messages-cap 1000)
(def limit-question "The message limit is reached. Extend it to go on, or close the session.")
(def limit-reached "This conversation has reached its message limit. Only the operator can take it now: hand it to the operator.")

(defn blank? [s] (str/blank? (or s "")))

(defn course
  "The course as today's row `state`: open · needs-you · done · closed (from the chart's `:course`)."
  [data]
  (:course data))

(defn ended? [data] (contains? #{"done" "closed"} (course data)))

(defn budget-spent? [data]
  (let [{:keys [messages-used messages-max]} (:budget data)]
    (>= (or messages-used 0) (or messages-max 60))))

(defn current-offer
  "The row's current offer (open or held), or nil."
  [data]
  (when-let [id (:offer-id data)]
    (first (filter #(and (= id (:id %)) (not= "withdrawn" (:state %))) (:offers data)))))

(defn name-of [data ref]
  (cond
    (= ref operator) (or (:operator-name data) "the operator")
    :else (or (get (:names data) ref) (get (:names data) (keyword ref)) "Someone")))

;; ---- moves ----------------------------------------------------------------------------------------

(defn ended-refusal
  "A move on a done or closed session."
  [data]
  (when (ended? data) (r/refuse 409 (str "This session is " (course data) "."))))

(defn move-refusal
  "moveRefusal(r, to): done/closed, the holder already, the limit for anyone but the operator."
  [data to]
  (or (ended-refusal data)
      (when (= (:holder data) to) (r/refuse 409 "They already hold the baton."))
      (when (and (not= to operator) (budget-spent? data)) (r/refuse 409 limit-reached))))

(defn hand-to-refusal
  "hand_to, in its order: the session ended, the target (the host resolved it: `invalid`), the
   holder chose them, the question, then moveRefusal."
  [data {:keys [target chosen question invalid]}]
  (let [to (:id target)]
    (cond
      (ended? data) (r/refuse 409 (str "This conversation is " (course data) "."))
      (not (blank? invalid)) (r/refuse 400 invalid)
      (nil? to) (r/refuse 400 "Name the person to hand to.")
      (and (:holder data) (not= operator (:holder data)) (not= pool (:holder data)) (not= operator to) (not chosen))
      (let [h (name-of data (:holder data)) t (or (:name target) (name-of data to))]
        (r/refuse 409 (str "Not handed over: " h " has not chosen " t ". Tell " h " who could answer (name and decision area, from the list) and ask them to choose; hand over once they name or confirm someone.")))
      (blank? question) (r/refuse 400 "Give the question you need them to answer.")
      :else (move-refusal data to))))

(defn handoff-refusal
  "The operator's hand-off route: an active person (the host resolved `target`), the question."
  [data {:keys [target question invalid]}]
  (cond
    (not (blank? invalid)) (r/refuse 400 invalid)
    (nil? (:id target)) (r/refuse 400 "to must be a roster person's id")
    (= "proposed" (:status target)) (r/refuse 409 (str "Approve " (:name target) " first."))
    (not= "active" (:status target)) (r/refuse 409 (str (:name target) " is not active."))
    (blank? question) (r/refuse 400 "question is required")
    :else (move-refusal data (:id target))))

(defn offer-refusal
  "An offer's refusals (the invitees, which the host resolved: `invalid`), then moveRefusal(POOL)."
  [data {:keys [invalid archived project-name]}]
  (cond
    archived (r/refuse 409 (str project-name " is archived. Unarchive it first."))
    (not (blank? invalid)) (r/refuse 400 invalid)
    :else (move-refusal data pool)))

(defn take-back-refusal [data]
  (or (ended-refusal data)
      (when (= operator (:holder data)) (r/refuse 409 "You already hold the baton."))))

(defn withdraw-refusal [data]
  (or (ended-refusal data)
      (when-not (current-offer data) (r/refuse 409 "There is no open offer."))))

(defn close-refusal
  "The operator's Close; the overseer's sova_close_gathering (its own, in today's order)."
  [data {:keys [by reason owner-project]}]
  (if (contains? #{"operator" "system"} by)
    (when (= "closed" (course data)) (r/refuse 409 "This session is already closed."))
    (cond
      (blank? reason) (r/refuse 400 "Say why you close it (reason).")
      (not= (get-in data [:owner :overseer-of]) owner-project) (r/refuse 409 "Not one of your gathering sessions.")
      (:conflict data) (r/refuse 409 "That is a settle session: the conflict ends when it is settled.")
      (ended? data) (r/refuse 409 (str "It is already " (course data) "."))
      (:wrote-at data) (r/refuse 409 "Someone it went to has already written in it."))))

(defn goal-done-refusal [data {:keys [summary]}]
  (cond
    (blank? summary) (r/refuse 400 "Give a summary of what was established.")
    (ended? data) (r/refuse 409 (str "This session is already " (course data) "."))))

(defn extend-refusal
  "Extend: refused once done or closed; the limit is at most 1000. The payload's `more` (the route's
   body field `by`: the envelope's own `by` is the actor)."
  [data {:keys [more invalid]}]
  (let [max (get-in data [:budget :messages-max] 60)
        by  more]
    (cond
      (not (blank? invalid)) (r/refuse 400 invalid)
      (not (and (integer? by) (<= 1 by messages-cap))) (r/refuse 400 (str "by must be a whole number from 1 to " messages-cap))
      (ended? data) (r/refuse 409 (str "This session is " (course data) "."))
      (> (+ max by) messages-cap) (r/refuse 400 (str "A conversation's limit is at most " messages-cap " messages (it is " max " now).")))))

(defn send-link-refusal
  "Send a person their link on a channel outside Sova (the host resolved `target`): an active person
   who holds the current hand-off, or an invitee of the current offer already reached (as Get Link)."
  [data {:keys [target invalid]}]
  (let [o   (current-offer data)
        pid (:id target)]
    (cond
      (not (blank? invalid)) (r/refuse 400 invalid)
      (ended? data) (r/refuse 409 (str "This session is " (course data) "."))
      (nil? pid) (r/refuse 400 "person must be a roster person's id")
      (not= "active" (:status target)) (r/refuse 409 (str (:name target) " is not active, so they get no link."))
      o (cond
          (not (some #{pid} (:to o))) (r/refuse 409 (str (:name target) " is not invited to the open offer."))
          (= "waiting" (get-in o [:reach pid :state]))
          (r/refuse 409 (str (:name target) " is not reached yet: their link is made when their working hours start.")))
      (not= pid (:holder data)) (r/refuse 409 (str (:name target) " does not hold the baton, so there is no link to send.")))))

(defn abilities-refusal [data {:keys [invalid]}]
  (cond
    (ended? data) (r/refuse 409 (str "This conversation is " (course data) "."))
    (not (blank? invalid)) (r/refuse 400 invalid)))

;; ---- messages -------------------------------------------------------------------------------------

(defn message-verdict
  "noteMessage for a message by `from` (a person id or operator): `{:claim? bool}` when it may be
   written, or a refusal (409; `:code` taken | budget for the share page). `active?` is the
   sender's roster status (the host stamps it)."
  [data {:keys [from active]}]
  (let [o (current-offer data)]
    (cond
      (ended? data) (r/refuse 409 (str "This conversation is " (course data) "."))
      (and (not= from operator) (not active)) (r/refuse 409 "You are no longer taking part in this conversation." :code "gone")
      :else
      (let [claim? (and o (= "open" (:state o)) (not= from operator) (some #{from} (:to o)) (reach/may-claim? o from))
            holder (if claim? from (:holder data))]
        (cond
          ;; r12: an invitee the offer has not reached (outside their hours) cannot claim it
          (and o (not= from operator) (some #{from} (:to o)) (not (reach/may-claim? o from)))
          (r/refuse 409 "This offer has not reached you yet." :code "taken")
          (and claim? (budget-spent? data)) (r/refuse 409 "This conversation has reached its message limit. The operator has been told." :code "budget")
          (not= holder from)
          (cond
            (and o (some #{from} (:to o)) (:holder o) (not= (:holder o) from)) (r/refuse 409 "Someone else is answering right now." :code "taken")
            (= from operator) (r/refuse 409 (if (and (:holder data) (not= pool (:holder data)))
                                              (str (name-of data (:holder data)) " holds the baton. Take it back to write.")
                                              "The baton is offered to people right now. Take it back to write."))
            :else (r/refuse 409 "It's not your turn anymore." :code "taken"))
          (budget-spent? data) (r/refuse 409 (if (= from operator)
                                               "This conversation has reached its message limit. Extend it to write."
                                               "This conversation has reached its message limit. The operator has been told.")
                                 :code "budget")
          :else {:claim? (boolean claim?)})))))

(defn wrote-for-it?
  "A message by someone the session was sent to: a roster person, or the operator when the first
   hand-off went to the operator."
  [data from]
  (or (not= from operator) (= operator (:to (first (:handoffs data))))))

;; ---- decisions and referrals -------------------------------------------------------------------------

(defn owner-area-refusal
  "pickOwnerArea: a roster decision area (any case; stored in the roster's spelling) or none."
  [{:keys [owner-area owner-areas]}]
  (when (and (not (blank? owner-area)) (not= "none" owner-area)
             (not-any? #(= (str/lower-case %) (str/lower-case owner-area)) owner-areas))
    (r/refuse 400 (str "\"" owner-area "\" is not an owner area. Use one of: " (str/join ", " (map #(str "\"" % "\"") owner-areas)) " or \"none\"."))))

(defn record-decision-refusal
  "record_decision: the area, the statement and the quote, then the owner area (a roster decision
   area, as the roster spells it, or none; the host stamps `owner-areas`)."
  [{:keys [area statement quote owner-area owner-areas]}]
  (cond
    (or (blank? area) (blank? statement) (blank? quote)) (r/refuse 400 "Give the area, the statement and their exact words.")
    :else (owner-area-refusal {:owner-area owner-area :owner-areas owner-areas})))

(defn spelled-owner-area
  "The owner area in the roster's spelling (the same key), or none."
  [{:keys [owner-area owner-areas]}]
  (if (or (blank? owner-area) (= "none" owner-area))
    "none"
    (or (first (filter #(= (str/lower-case %) (str/lower-case owner-area)) owner-areas)) owner-area)))

;; ---- wrap-up ----------------------------------------------------------------------------------------

(def wrapup-shut-down "The server shut down during the wrap-up.")
(def wrapup-overdue "It ran past 10 minutes without finishing.")

(defn retry-refusal
  "Retry Wrap-Up, in today's order (409 each)."
  [wrapup-state reply-idle?]
  (cond
    (= wrapup-state "running") (r/refuse 409 "The wrap-up is already running.")
    (not reply-idle?) (r/refuse 409 "A reply is running in this session. Retry when it finishes.")
    (not= wrapup-state "failed") (r/refuse 409 "Only a wrap-up that stopped can be retried.")))
