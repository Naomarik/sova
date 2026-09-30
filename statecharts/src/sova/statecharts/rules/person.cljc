(ns sova.statecharts.rules.person
  "The person statechart's rules, pure: field cleaning and caps (shared/orgs.ts, orgs.ts cleanField),
   field authority by writer (§app.organizations/field-authority), a proposed person's referral
   (proposedGaps, contactProblems) and the referral's name checks (propose_roster_edit). Every
   function returns a cleaned value or a refusal (`r/refuse`), never throws; the sentences are
   today's, byte for byte."
  (:require
    [clojure.string :as str]
    [sova.statecharts.rules.hours :as hours]
    [sova.statecharts.rules.refusal :as r]))

(def name-max 80)
(def text-max 300)
(def list-max 12)
(def item-max 40)
(def contact-max 200)
(def language-max 35)

(def profile-fields
  "PROFILE_FIELDS, in their order (one history line each). `tz` and `hours` (r7): the operator's,
   history lines like contact, not private."
  [:name :status :contact :role :decides :skills :competence :language :voice :tz :hours :referral])

(def contact-keys [:email :phone :whatsapp :other])

(def field-authority
  "FIELD_AUTHORITY: the fields each writer may set. `referral` may only create a proposed person."
  {"operator" (set profile-fields)
   "wrapup"   #{:skills :competence :language :voice}
   "overseer" #{:skills :competence :language :voice}
   "referral" #{:name :status :contact :role :decides :referral}})

(defn- trim [s] (str/trim s))

(defn- text
  "str(v, field, max): trimmed text, or a refusal."
  [v field max]
  (cond
    (not (string? v)) (r/refuse 400 (str field " must be text"))
    (> (count (trim v)) max) (r/refuse 400 (str field " must be at most " max " characters"))
    :else (trim v)))

(defn- lower [s] (str/lower-case s))

(defn- clean-list
  "list(v, field): trimmed, blank and case-insensitive duplicates dropped, at most 12."
  [v field]
  (if-not (sequential? v)
    (r/refuse 400 (str field " must be a list"))
    (let [out (reduce (fn [acc x]
                        (let [t (text x (str field " item") item-max)]
                          (cond
                            (r/refusal? t) (reduced t)
                            (or (= "" t) (some #(= (lower %) (lower t)) acc)) acc
                            :else (conj acc t))))
                []
                v)]
      (cond
        (r/refusal? out) out
        (> (count out) list-max) (r/refuse 400 (str field " must have at most " list-max " items"))
        :else out))))

(defn- strip-accents
  "NFKD, then the combining marks dropped (the decides letter test)."
  [s]
  #?(:clj  (str/replace (java.text.Normalizer/normalize s java.text.Normalizer$Form/NFKD) #"[̀-ͯ]" "")
     :cljs (str/replace (.normalize s "NFKD") #"[̀-ͯ]" "")))

(defn- has-letter? [s] (boolean (re-find #"[a-z]" (lower (strip-accents s)))))

(def bcp47 #"^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$")

(defn clean-field
  "cleanField(field, v): the value as stored, or a refusal (400)."
  [field v]
  (case field
    :name (let [n (text v "name" name-max)]
            (cond (r/refusal? n) n (= "" n) (r/refuse 400 "name is required") :else n))
    :status (if (contains? #{"active" "proposed" "left"} v) v (r/refuse 400 "status must be active, proposed or left"))
    :contact (if-not (map? v)
               (r/refuse 400 "contact must be an object")
               (reduce (fn [c k]
                         (let [x (get v k)]
                           (if (nil? x)
                             c
                             (let [t (text x (str "contact." (name k)) contact-max)]
                               (cond (r/refusal? t) (reduced t) (= "" t) c :else (assoc c k t))))))
                 {} contact-keys))
    :role (text v "role" text-max)
    :voice (text v "voice" text-max)
    :language (let [t (text v "language" language-max)]
                (cond (r/refusal? t) t
                      (and (not= "" t) (not (re-matches bcp47 t))) (r/refuse 400 "language must be a BCP-47 tag such as es-CO")
                      :else t))
    :decides (let [out (clean-list v "decides")]
               (if (r/refusal? out)
                 out
                 (if-let [bad (first (remove has-letter? out))]
                   (r/refuse 400 (str "“" bad "” names no decision area: use words, like “website”."))
                   out)))
    :skills (clean-list v "skills")
    :tz (if-let [p (hours/tz-problem v)] (r/refuse 400 p) (or v ""))
    :hours (if-let [p (hours/hours-problem v)]
             (r/refuse 400 p)
             (when v {:days (vec (sort (:days v))) :from (:from v) :to (:to v)}))
    :competence (if-not (map? v)
                  (r/refuse 400 "competence must be an object")
                  (let [out (reduce (fn [acc [k c]]
                                      (let [key (text (if (keyword? k) (name k) (str k)) "competence skill" item-max)]
                                        (cond
                                          (r/refusal? key) (reduced key)
                                          (not (and (map? c) (contains? #{1 2 3 4 5} (:level c)) (number? (:n c)) (>= (:n c) 0)))
                                          (reduced (r/refuse 400 (str "competence." key " must be {level 1–5, n ≥ 0}")))
                                          :else (assoc acc key {:level (:level c) :n (long (Math/floor (:n c)))}))))
                              {} v)]
                    (cond (r/refusal? out) out
                          (> (count out) list-max) (r/refuse 400 (str "competence must have at most " list-max " skills"))
                          :else out)))
    :referral (cond
                (nil? v) nil
                (not (map? v)) (r/refuse 400 "referral must be an object")
                :else (let [why (text (or (:why v) "") "referral.why" text-max)
                            by  (text (or (:referred-by v) "") "referral.referredBy" name-max)
                            q   (when (and (string? (:quote v)) (not (str/blank? (:quote v)))) (text (:quote v) "referral.quote" text-max))]
                        (or (first (filter r/refusal? [why by q]))
                            (cond-> {:why why :referred-by by}
                              (and (string? (:session-id v)) (not= "" (:session-id v))) (assoc :session-id (:session-id v))
                              q (assoc :quote q)))))
    (r/refuse 400 (str "Unknown field: " (name field)))))

(defn contact-problems
  "contactProblems(c): one problem per contact value that is not a way to reach anyone."
  [c]
  (let [v (fn [k] (trim (or (get c k) "")))
        phone? (fn [s] (and (re-matches #"^\+?[\d\s().-]+$" s) (>= (count (re-seq #"\d" s)) 7)))]
    (cond-> []
      (and (not= "" (v :email)) (not (re-matches #"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$" (v :email)))) (conj "the email is not an email address")
      (and (not= "" (v :phone)) (not (phone? (v :phone)))) (conj "the phone is not a phone number")
      (and (not= "" (v :whatsapp)) (not (phone? (v :whatsapp)))) (conj "the WhatsApp is not a phone number")
      (and (not= "" (v :other)) (not (re-find #"[@\d:]" (v :other)))) (conj "the other channel names no handle or number"))))

(defn- blank? [s] (str/blank? (or s "")))

(defn proposed-gaps
  "proposedGaps(p): what a proposed person lacks, in today's order; empty when complete."
  [{:keys [name contact role referral]}]
  (cond-> []
    (blank? name) (conj "name")
    (not-any? #(not (blank? (get contact %))) contact-keys) (conj "a contact channel")
    (blank? role) (conj "role")
    (blank? (:why referral)) (conj "why they were referred")
    (blank? (:referred-by referral)) (conj "who referred them")))

;; ---- a change (applyChange), as the person statechart takes it -------------------------------------------

(defn authority-refusal
  "The first field of `fields` outside `writer`'s authority, refused whole (409). The overseer's one
   exception (a status write that approves or declines) is its own transition, not a field write."
  [writer fields]
  (let [allowed (get field-authority writer)]
    (cond
      (nil? allowed) (r/refuse 400 (str "Unknown writer: " writer))
      :else (when-let [f (first (remove allowed fields))]
              (r/refuse 409 (str "A " writer " change may not write " (name f) "."))))))

(defn- same? [a b]
  (= (if (and (coll? a) (empty? a)) nil a) (if (and (coll? b) (empty? b)) nil b)))

(defn- emptyish? [v] (or (nil? v) (= "" v) (and (coll? v) (empty? v))))

(defn apply-change
  "A change `patch` ({field value}) to `current` (nil: creating) by `writer`: the cleaned person
   and the changed fields `[{:field :from :to}]` in PROFILE_FIELDS order, or a refusal. Checks in
   applyChange's order: unknown field, authority, (referral: creating a proposed person only),
   each value, name, a proposed person's gaps, a referral's contact channel. The duplicate-name
   check needs the roster: `names-taken` (lower-cased names of the other people not left)."
  [current patch writer names-taken]
  (let [fields  (filter #(contains? patch %) (concat profile-fields (remove (set profile-fields) (keys patch))))
        unknown (first (remove (set profile-fields) fields))
        creating (nil? current)]
    (or
      (when unknown (r/refuse 400 (str "Unknown field: " (name unknown))))
      (authority-refusal writer fields)
      (when (and (= writer "referral") (or (not creating) (not= "proposed" (get patch :status))))
        (r/refuse 409 "A referral may only create a proposed person."))
      (let [base    (or current {:name "" :status "active" :contact {} :role "" :decides [] :skills [] :competence {} :language "" :voice ""})
            step    (reduce (fn [[nxt changed] f]
                              (let [to (clean-field f (get patch f))]
                                (cond
                                  (r/refusal? to) (reduced to)
                                  (and (not creating) (same? (get base f) to)) [nxt changed]
                                  (and creating (emptyish? to)) [nxt changed]
                                  :else [(if (nil? to) (dissoc nxt f) (assoc nxt f to))
                                         (conj changed {:field f :from (if creating nil (get base f)) :to to})])))
                      [base []] fields)]
        (if (r/refusal? step)
          step
          (let [[nxt changed] step
                changed (if (and creating (not-any? #(= :status (:field %)) changed))
                          (conj changed {:field :status :from nil :to (:status nxt)})
                          changed)]
            (cond
              (blank? (:name nxt)) (r/refuse 400 "name is required")
              (and (= "proposed" (:status nxt)) (seq (proposed-gaps nxt)))
              (r/refuse 400 (str "A proposed person needs " (str/join ", " (proposed-gaps nxt)) "."))
              (and (= writer "referral") (seq (contact-problems (:contact nxt))))
              (r/refuse 400 (str "A referral needs a real way to reach them: " (str/join "; " (contact-problems (:contact nxt))) "."))
              (empty? changed) {:person base :changed []}
              (contains? (set names-taken) (lower (:name nxt))) (r/refuse 409 (str (:name nxt) " is already on the roster."))
              :else {:person nxt :changed changed})))))))

;; ---- the referral (propose_roster_edit), as the baton model's act ------------------------------------

(defn referral-refusal
  "propose_roster_edit's refusals, in its order: a former person of that name, an active one, a
   proposed one, then what is missing (gaps, a real contact, the quote). `same` is the person of
   that name (case-insensitive) as `{:name :status :referral?}` or nil; `referrer` the holder's name."
  [{:keys [name role contact why quote]} same referrer]
  (let [former (when (= "left" (:status same)) same)]
    (cond
      former (r/refuse 409 (if (:referral former)
                             (str (:name former) " was proposed before and the operator declined. Ask " referrer " who else could answer.")
                             (str (:name former) " has left the organization. Tell " referrer " so and ask who covers their area now; if this is a different person with the same name, hand to the operator.")))
      (= "active" (:status same)) (r/refuse 409 (str (:name same) " is already on the roster: hand_to them if they should answer."))
      (= "proposed" (:status same)) (r/refuse 409 (str (:name same) " was already proposed and waits for the operator's approval. Hand to the operator if you need them now."))
      :else
      (let [gaps (cond-> (proposed-gaps {:name name :role role :contact contact :referral {:why why :referred-by referrer}})
                   (seq (contact-problems contact)) (conj (str "a real contact channel (" (str/join "; " (contact-problems contact)) "; never write a placeholder)"))
                   (blank? quote) (conj (str referrer "'s exact words referring them")))]
        (when (seq gaps)
          (r/refuse 400 (str "Not recorded yet: still missing " (str/join ", " gaps) ". Ask " referrer " for it, then call propose_roster_edit again with everything.")))))))
