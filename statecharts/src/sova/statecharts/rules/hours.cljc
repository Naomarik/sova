(ns sova.statecharts.rules.hours
  "A person's working hours (r7): an IANA time zone `:tz` and `:hours {:days [0..6] :from \"HH:MM\"
   :to \"HH:MM\"}` (0 = Sunday; `to` ≤ `from` is an overnight window, it ends the next day). Pure:
   `next-window` answers when an act that reaches them may go (nil = now), from a clock the caller
   gives. Local times follow java.time: a time that doesn't exist (spring forward) moves on by the
   gap, an ambiguous one (fall back) is the earlier instant. The server reads the same fn."
  (:require [clojure.string :as str]))

(def ^:private day-ms 86400000)
(def ^:private minute-ms 60000)

;; ---- the zone's offset at an instant (the one platform-specific part) ---------------------------

(defn valid-zone? [tz]
  (and (string? tz) (not (str/blank? tz))
       (boolean #?(:clj  (try (java.time.ZoneId/of tz) true (catch Exception _ false))
                   :cljs (try (js/Intl.DateTimeFormat. "en-US" #js {:timeZone tz}) true (catch :default _ false))))))

(defn offset-ms
  "The zone's UTC offset at instant `t` (ms)."
  [tz t]
  #?(:clj  (* 1000 (.getTotalSeconds (.getOffset (.getRules (java.time.ZoneId/of tz)) (java.time.Instant/ofEpochMilli t))))
     :cljs (let [f     (js/Intl.DateTimeFormat. "en-US" #js {:timeZone tz :hourCycle "h23" :year "numeric" :month "numeric"
                                                              :day "numeric" :hour "numeric" :minute "numeric" :second "numeric"})
                 parts (into {} (for [p (.formatToParts f (js/Date. t))] [(.-type p) (js/parseInt (.-value p) 10)]))
                 wall  (js/Date.UTC (get parts "year") (dec (get parts "month")) (get parts "day")
                                    (get parts "hour") (get parts "minute") (get parts "second"))]
             (- wall (* 1000 (quot t 1000))))))

;; ---- wall clock <-> instant ---------------------------------------------------------------------

(defn- wall-of
  "The local wall clock at `t`, as ms of a UTC calendar (fields read in UTC)."
  [tz t]
  (+ t (offset-ms tz t)))

(defn instant-of
  "The instant of local wall clock `w` (ms of a UTC calendar) in `tz`: a gap moves on by its length,
   an overlap takes the earlier instant (java.time's ZonedDateTime.of)."
  [tz w]
  (let [before (offset-ms tz (- w (* 12 3600000)))
        after  (offset-ms tz (+ w (* 12 3600000)))
        ok     (filter #(= (wall-of tz %) w) (distinct [(- w before) (- w after)]))]
    (if (seq ok) (apply min ok) (- w before))))

(defn- dow
  "Day of week of a UTC-calendar ms: 0 = Sunday."
  [w]
  (mod (+ 4 (quot (if (neg? w) (- w (dec day-ms)) w) day-ms)) 7))

(defn- midnight [w] (* day-ms (quot (if (neg? w) (- w (dec day-ms)) w) day-ms)))

(defn- parse-long* [s] #?(:clj (Long/parseLong s) :cljs (js/parseInt s 10)))

(defn- minutes
  "\"HH:MM\" → minutes after midnight, or nil."
  [s]
  (when-let [[_ h m] (and (string? s) (re-matches #"(\d{2}):(\d{2})" s))]
    (let [h (parse-long* h) m (parse-long* m)]
      (when (and (<= 0 h 23) (<= 0 m 59)) (+ (* 60 h) m)))))

;; ---- validation (person/edit: 400 with the sentence) ---------------------------------------------

(defn tz-problem [tz]
  (when-not (or (nil? tz) (= "" tz) (valid-zone? tz))
    "tz must be an IANA time zone, like Europe/Istanbul"))

(defn hours-problem [h]
  (cond
    (nil? h) nil
    (not (map? h)) "hours must be { days, from, to } or null"
    (not (and (sequential? (:days h)) (seq (:days h)) (every? #(and (integer? %) (<= 0 % 6)) (:days h))
              (apply distinct? (:days h))))
    "hours.days must list days 0–6 (0 is Sunday), each once"
    (not (and (minutes (:from h)) (minutes (:to h)))) "hours.from and hours.to must be times like 09:00"
    (= (:from h) (:to h)) "hours.from and hours.to must differ"))

;; ---- the next window ----------------------------------------------------------------------------

(defn windows
  "The person's windows `[start end]` (instants) that begin on local days `d0-1 … d0+8`."
  [{:keys [tz hours]} now]
  (let [from  (minutes (:from hours))
        to    (minutes (:to hours))
        days  (set (:days hours))
        today (midnight (wall-of tz now))]
    (for [k (range -1 9)
          :let [d (+ today (* k day-ms))]
          :when (contains? days (dow d))]
      [(instant-of tz (+ d (* from minute-ms)))
       (instant-of tz (+ d (if (<= to from) day-ms 0) (* to minute-ms)))])))

(defn- own-hours? [{:keys [tz hours]}] (and (valid-zone? tz) (map? hours) (nil? (hours-problem hours))))

(defn effective
  "r13: the working hours an act that reaches this person reads: their own `{:tz :hours}` when set
   (valid), else the company's (the org's) when set, else nil (always in hours, as today)."
  [person company]
  (cond
    (own-hours? person) (select-keys person [:tz :hours])
    (own-hours? company) (select-keys company [:tz :hours])
    :else nil))

(defn inherited? "Their effective hours are the company's." [person company]
  (and (not (own-hours? person)) (own-hours? company)))

(defn hours-from
  "Which hours `effective` used: \"own\", \"company\" or \"none\" (always in hours). The zone and the
   hours go together: a zone of their own without hours takes the company's pair."
  [person company]
  (cond (own-hours? person) "own" (own-hours? company) "company" :else "none"))

(defn next-window
  "When an act that reaches this person may go: nil when they have no zone or hours (as today) or
   `now` is inside a window; else the instant (ms) their next window opens."
  [person now]
  (let [{:keys [tz hours]} person]
    (when (and (valid-zone? tz) (map? hours) (nil? (hours-problem hours)))
      (let [ws (windows person now)]
        (when-not (some (fn [[s e]] (and (<= s now) (< now e))) ws)
          (some (fn [[s _]] (when (> s now) s)) (sort-by first ws)))))))

(defn reach-times
  "Each person's own reach time: `{id → nil (now) | ms}` (r7, per-invitee delivery of an offer)."
  [people now]
  (into {} (map (fn [p] [(:id p) (next-window p now)])) people))

(defn reach-window
  "An act that reaches `people` (person records with :tz/:hours): nil when any of them is in hours
   (or has none: always open, as today), else the earliest of their next windows."
  [people now]
  (when (seq people)
    (let [nexts (map #(next-window % now) people)]
      (when (every? some? nexts) (apply min nexts)))))

(defn open-now?
  "hoursNow for reads: `{:open bool :next-open ms?}`, nil without hours."
  [person now]
  (when (and (valid-zone? (:tz person)) (map? (:hours person)))
    (if-let [n (next-window person now)] {:open false :next-open n} {:open true})))
