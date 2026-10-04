(ns sova.statecharts.refit.matrix-test
  "The enumerated matrix (design §10 bar M) of every refit statechart, through the engine's generator
   (`engine/matrix.cljs`): every configuration a session reaches from its starts (by facts, link
   notifications, timers and every accepted act) × every act × every envelope is SENT on a
   checkpoint, and: accepted (taken or held) ⇔ explain is nil; a refused send answers explain's
   sentence; every sentence is one of today's (the catalogue below, as patterns over today's
   templates). Sessions the statechart under test talks to are absorbed by the generator's sink."
  (:require
    [cljs.test :refer [deftest is testing]]
    [clojure.string :as str]
    [sova.statecharts.registry :as registry]
    [sova.statecharts.rules.levels :as lv]
    [sova.statecharts.engine.matrix :as matrix]))

;; ---- envelopes (design §10: operator, attended, L0–L3, paused, a ceiling (an empty roster), archived, capped at
;; once, capped day, capped message, via-overseer with and without a card) ---------------------------

(def plenty {:gather {:used 0 :max 6} :promote {:used 0 :max 60} :create {:used 0 :max 4} :prompt {:used 0 :max 12}})
(def spent {:gather {:used 6 :max 6} :promote {:used 60 :max 60} :create {:used 4 :max 4} :prompt {:used 12 :max 12}})
(def room {:gatherings-open 0 :gatherings-cap 5 :coding-running 0 :coding-cap 2})
(def full {:gatherings-open 5 :gatherings-cap 5 :coding-running 2 :coding-cap 2})
(def base {:paused false :archived false :allowance plenty :at-once room :ledger "day" :hold-ms 0})

(def envelopes
  {"operator"      {:by "operator"}
   "attended"      (merge base {:by "overseer" :attended true :autonomy "L0" :ledger "message"})
   "L0"            (merge base {:by "overseer" :autonomy "L0"})
   "L1"            (merge base {:by "overseer" :autonomy "L1"})
   "L2"            (merge base {:by "overseer" :autonomy "L2"})
   "L3"            (merge base {:by "overseer" :autonomy "L3"})
   "L3-held"       (merge base {:by "overseer" :autonomy "L3" :hold-ms 600000})
   "paused"        (merge base {:by "overseer" :autonomy "L3" :paused true})
   "ceiling-L0"    (merge base {:by "overseer" :autonomy "L3" :ceiling {:autonomy "L0" :reason "The roster has no active people yet, so the overseer only proposes (L0)."}})
   "ceiling-L2"    (merge base {:by "overseer" :autonomy "L3" :ceiling {:autonomy "L2" :reason "Capped."}})
   "archived"      (merge base {:by "overseer" :autonomy "L3" :archived true :project-name "Site"})
   "capped-once"   (merge base {:by "overseer" :autonomy "L3" :at-once full})
   "capped-day"    (merge base {:by "overseer" :autonomy "L3" :allowance spent})
   "capped-msg"    (merge base {:by "overseer" :attended true :autonomy "L3" :allowance spent :ledger "message"})
   "go-no-card"    {:by "operator" :via "overseer"}
   "go-card"       {:by "operator" :via "overseer" :card {:people ["p1" "p2"] :sessions ["s1"] :projects ["pr1"]}}
   "statechart"         (merge base {:by "statechart" :autonomy "L3"})
   "model"         {:by "model"}
   "person"        {:by "person"}
   "wrapup"        {:by "wrapup"}})

;; ---- the sentence catalogue: today's templates -----------------------------------------------------

(def catalogue
  (mapv re-pattern
    ["^This run was not started by the operator, and your autonomy here is L\\d( \\(.*\\))?; sova_\\w+ needs L\\d\\. Do not retry it\\..*"
     "^The to-do list is the operator's own.*" "^sova_todo changes the operator's own to-do list.*"
     "^Today's allowance is used: \\d+ of \\d+ .* on its own\\. It looks again at midnight\\..*"
     "^This message's allowance is used: \\d+ of \\d+ .* per message you send\\..*"
     "^\\d+ of its (gathering sessions are open|coding sessions are running), and the limit is \\d+ at once\\..*"
     "^This reaches people or ends something: ask with sova_card, listing .* in its items, and act in the turn the user's click starts\\.$"
     "^A correction needs a reason: say why\\.$" "^No held act has that id\\.$" "^That can't be done now\\.$"
     ;; org, residence, person
     "^name must be 1–80 characters$" "^Only an active person on the roster can be the owner\\.$"
     "^That organization is already attached here\\.$" "^Unknown organization$"
     "^.* is not waiting for approval\\.$" "^.* is (active|left|proposed), not proposed\\.$"
     "^A \\w+ change may not (write \\w+|approve or decline people)\\.$" "^A referral may only create a proposed person\\.$"
     "^.* has already left\\.$" "^Unknown writer: .*" "^No such change$" "^A person's creation can't be reverted; set their status to left instead\\.$"
     "^.*'s \\w+ has changed since then, so reverting this would undo a later change\\. Revert the latest change instead\\.$"
     "^.* is already on the roster\\.$" "^A proposed person needs .*\\.$" "^A referral needs a real way to reach them: .*\\.$"
     "^(name|role|voice|language|contact\\.\\w+|decides|skills|competence|referral\\.\\w+|decides item|skills item|competence skill) .*"
     "^“.*” names no decision area: use words, like “website”\\.$" "^status must be active, proposed or left$" "^Unknown field: .*"
     ;; project, watch
     "^.* is archived\\. Unarchive it (first|to use its overseer)\\.$" "^Stop these first: .*\\.$"
     "^Only an active person on the roster can be a project's main stakeholder\\.$"
     "^This organization has no owner, so there is no page to post to\\.$" "^Write the update first\\.$"
     "^An update is at most 2,000 characters\\.$" "^An update was posted .*: at most one a day\\.$"
     "^Nothing new since the last update: .*" "^A coding session starts only in a turn the operator started: ask with sova_card\\.$"
     "^Not started: .*\\.$"
     ;; placement (outreach)
     "^Send a link, a note, or both\\.$" "^A note is at most 500 characters\\.$" "^person must be a roster person's id$"
     ;; baton
     "^This (session|conversation) is (already )?(open|done|closed)\\.$" "^They already hold the baton\\.$"
     "^This conversation has reached its message limit\\. .*" "^Not handed over: .*" "^Give the question you need them to answer\\.$"
     "^Name the person to hand to\\.$" "^to must be a roster person's id$" "^Approve .* first\\.$" "^.* is not active\\.$"
     "^question is required$" "^You already hold the baton\\.$" "^There is no open offer\\.$" "^Say why you close it \\(reason\\)\\.$"
     "^Not one of your gathering sessions\\.$" "^That is a settle session: the conflict ends when it is settled\\.$"
     "^It is already (done|closed)\\.$" "^Someone it went to has already written in it\\.$"
     "^Give a summary of what was established\\.$" "^by must be a whole number from 1 to 1000$"
     "^A conversation's limit is at most 1000 messages \\(it is \\d+ now\\)\\.$" "^You are no longer taking part in this conversation\\.$"
     "^Someone else is answering right now\\.$" "^It's not your turn anymore\\.$" "^This offer has not reached you yet\\.$" "^.* holds the baton\\. Take it back to write\\.$"
     "^.* already has an open build \\(\".*\"\\): merge it or remove its worktree first; a decision promoted since is built after\\.$"
     "^Only the operator sets the company's working hours\\.$" "^tz must be an IANA time zone, like Europe/Istanbul$"
     "^The baton is offered to people right now\\. Take it back to write\\.$" "^Give the area, the statement and their exact words\\.$"
     "^\".*\" is not an owner area\\. Use one of: .* or \"none\"\\.$" "^The wrap-up is already running\\.$"
     "^A reply is running in this session\\. Retry when it finishes\\.$" "^Only a wrap-up that stopped can be retried\\.$"
     "^Not recorded( yet)?: .*" "^.* (is already on the roster: hand_to them|was already proposed and waits|was proposed before and the operator declined|has left the organization).*"
     ;; decisions, reconciler, conflict
     "^That decision was superseded: its owner area no longer decides anything\\.$" "^Its words in the spec are as they were promoted\\.$"
     "^Turn on Reconcile decisions in Settings → Decisions\\.$" "^Give the ids to promote\\.$" "^Promoted 0, refused \\d+: .*\\.$"
     "^The last run did not fail\\.$" "^That conflict is resolved$" "^Route to an active person or the operator$"
     "^Expected \\{ keep: \"a\" \\| \"b\" \\| \"both\" \\} or \\{ statement \\}$" "^statement must be 1–500 characters$"
     ;; item, build
     "^This idea was dropped; dropped is final\\. File a new idea instead\\.$" "^.* is (already on hold|not on hold|not done|not waiting on a start)\\.$"
     "^.* is on hold: only the operator resumes it\\.$" "^Only the operator holds or resumes a gap, from the project page\\.$"
     "^.* has no promoted decision to build yet\\.$" "^.* is not a promoted, not yet built decision of .*"
     "^That session is not one of this gap's\\.$" "^Name the gap to move it to\\.$"
     "^It runs in the project root.*" "^The session is working\\.$" "^Its workers are running\\.$" "^On another host: its worktree is there\\.$"
     "^Its worktree was (already )?removed.*" "^\".*\" is open in a terminal, so it is read-only\\.$" "^text must not be blank\\.$"
     "^A merge is running\\.$" "^Name the commit it was merged by\\.$"
     "^Only the operator approves a definition\\.$" "^There is no definition waiting for approval\\.$"
     "^The definition changed since it was shown: look again\\.$"
     "^The project's software is registered and current: the playbook has nothing to do\\.$"
     "^Say what it shows and to whom \\(purpose\\): one line\\.$" "^The purpose is one line of at most 200 characters\\.$"]))

(defn in-catalogue? [s] (boolean (some #(re-matches % s) catalogue)))

;; ---- running ----------------------------------------------------------------------------------------

;; The world (engine matrix `:world`): per statechart, exactly the existing sessions of its fixture it sends
;; to, watches or drives (what it spawns is real, not absorbed). Anything else, a malformed id
;; included, fails its cell. The project-layer worlds (project, watch, build) are solo: no organization,
;; no person, nothing of the org layer (the seam: they never address it); the project's holds one build
;; an item started.
(def worlds
  {"person"     #{"org/o1"}
   "org"        #{"person/o1/p1" "project/pr9"}
   "residence"  #{"org/o1"}
   "project"    #{"build/pr1/c7"}
   "placement"  #{"person/o1/p1" "project/pr1" "watch/pr1"}
   "watch"      #{"project/pr1"}
   "baton"      #{"person/o1/p1" "person/o1/p2" "placement/o1/pr1" "reconciler/o1/pr1" "watch/pr1"}
   "decision"   #{"placement/o1/pr1" "reconciler/o1/pr1"}
   "reconciler" #{"watch/pr1"}
   "conflict"   #{"baton/o1/s9" "person/o1/p1" "watch/pr1"}
   "item"       #{"baton/o1/b1" "decision/o1/pr1/d1" "item/o1/pr1/g_2" "person/o1/p1" "placement/o1/pr1" "project/pr1" "watch/pr1"}
   "build"      #{"watch/pr1"}
   "runtime"    #{"watch/pr1" "build/pr1/o1"}})

(defn run [statechart sid spec]
  (matrix/run (merge {:statecharts registry/statecharts :statechart statechart :sid sid :level-check lv/level-check
                      :envelopes envelopes :sentences in-catalogue? :max-configs 4000
                      :world (get worlds statechart #{})}
                spec)))

(defn clean! [label r]
  (is (empty? (:failures r))
      (str label ": " (count (:failures r)) " failures; distinct: "
        (pr-str (take 12 (distinct (map #(select-keys % [:why :act :explain :refused :error :envelope]) (:failures r)))))))
  (is (not (:truncated r)) (str label ": truncated"))
  (is (pos? (:accepted r)) label)
  (is (pos? (:refused r)) label))

(defn moved [statechart from states & [ex]] [:link/moved {:from from :statechart statechart :states states :exported (or ex {})}])

;; ---- per statechart --------------------------------------------------------------------------------------

(def names {"p1" "Ana" "p2" "Bob"})

(deftest person-matrix
  (let [person (fn [status extra] {:org-id "o1" :id "p1" :person (merge {:name "Ana" :status status :role "R" :contact {:email "ana@example.test"}} extra) :changed [] :by {:kind "operator"}})
        referral {:why "w" :referred-by "p2"}]
    (clean! "person"
      (run "person" "person/o1/p1"
        {:starts [(person "active" {}) (person "proposed" {:referral referral})]
         ;; r13: the company's hours come and go (the effective ones follow)
         :drive [(moved "org" "org/o1" [:org :owner-none] {:name "Acme" :tz "UTC" :hours {:days [1 2 3 4 5] :from "09:00" :to "17:00"}})
                 (moved "org" "org/o1" [:org :owner-none] {:name "Acme"})]
         :acts [[:person/edit {:patch {:role "Boss"}}] [:person/edit {:patch {:tz "Europe/Istanbul" :hours {:days [1] :from "09:00" :to "17:00"}}}] [:person/edit {:patch {:status "left"}}] [:person/edit {:patch {:status "active"}}]
                [:person/edit {:patch {:status "proposed" :referral referral}}] [:person/edit {:patch {:language "es-CO"}}]
                [:person/edit {:patch {:name "Bob"} :names-taken ["bob"]}] [:person/approve {}] [:person/decline {}] [:person/leave {}]
                [:person/revert {:row {:at 1 :field "role" :from "X" :to "R"}}] [:person/revert {:row {:at 2 :field "status" :from "left" :to "active"}}]
                [:person/revert {:row {:at 3 :field "name" :from nil :to "Ana"}}] [:hold/cancel {:id "x" :reason "r"}]]}))))

(deftest org-matrix
  (clean! "org"
    (run "org" "org/o1"
      {:starts [{:id "o1" :name "Acme"}]
       :drive [(moved "person" "person/o1/p1" [:person :left] {:name "Ana"})]
       :acts [[:owner/set {:person-id "p1" :target {:status "active"}}] [:owner/set {:person-id nil}] [:owner/set {:person-id "p2" :target {:status "left"}}]
              [:org/rename {:name "New"}] [:org/rename {:name ""}]
              [:org/hours {:tz "UTC" :hours {:days [1 2 3 4 5] :from "09:00" :to "17:00"}}] [:org/hours {:tz "" :hours nil}] [:org/hours {:tz "Mars/Olympus"}] [:project/place {:project-id "pr9" :placed-via "born"}]
              [:person/add {:person-id "p9" :person {:name "Cy"} :names-taken []}] [:person/add {:person-id "p9" :person {:name "Ana"} :names-taken ["ana"]}]]})))

(deftest residence-matrix
  (clean! "residence"
    (run "residence" "residence/o1"
      {:starts [{:org-id "o1" :host-id "h_me" :host-name "me" :mode "attach"} {:org-id "o1" :host-id "h_me" :mode "create"}]
       :drive [[:effect/done {:kind "read-holder" :result {:local {:host-id "h_x" :host-name "box"}}}]
               [:effect/done {:kind "read-holder" :result {}}] [:store/written {}] [:fire 3600000]
               [:effect/done {:kind "commit" :result {}}] [:effect/failed {:kind "commit" :detail "git"}]]
       :acts [[:attach/confirm {}] [:org/detach {}] [:commit/now {}]]})))

(deftest project-matrix
  ;; a solo world: a project in no organization (its world holds no session at all)
  (clean! "project"
    (run "project" "project/pr1"
      {:starts [{:id "pr1" :name "Site" :root "/r" :origin "folder"}]
       :drive [[:started/noted {:sid "build/pr1/c7" :kind "coding"}]
               (moved "build" "build/pr1/c7" [:build :merged :turn-idle] {:merged {:at 5 :commit "c"}})]
       :acts [[:project/archive {}] [:project/archive {:blockers {:phrases ["1 gathering session open (A)"] :coding ["B"]}}] [:project/unarchive {}]
              [:project/edit {:name "Shop" :root "/s"}]
              [:overseer/start {:conversation-id "c1"}] [:overseer/clear {:conversation-id "c2"}]
              [:build/start {:session-id "c1" :title "T" :prompt "P"}]
              [:session/prompt {:session-id "c9" :title "T" :text "go"}] [:session/prompt {:session-id "c9" :title "T" :text " "}] [:session/prompt {:session-id "c9" :title "T" :text "go" :live true}]
              [:preview/start {:coding-session "c1" :port 5173 :purpose "The shop for Ana"}] [:preview/start {:coding-session "c1" :folder "dist" :purpose " "}]
              [:services/run {:verb "up"}] [:services/down {:verb "down"}]
              [:services/share {:verb "share" :instance "in_1" :endpoint "web.3000" :branch "sova/b"}]
              [:verbs/onboard {:session-id "o1" :title "Project verbs" :prompt "Run it" :why "w"}]
              [:verbs/onboard {:session-id "o2" :prompt "Run it" :runtime-standing "registered"}]]})))

(deftest placement-matrix
  (clean! "placement"
    (run "placement" "placement/o1/pr1"
      {:starts [{:org-id "o1" :project-id "pr1" :via "born" :placed-at 1}]
       :drive [[:milestone/noted {:kind "baton-done"}] [:fire (* 24 3600000)]
               (moved "person" "person/o1/p1" [:person :left] {:name "Ana"})
               (moved "project" "project/pr1" [:project :active] {:name "Site" :last-merged-at 7})
               (moved "project" "project/pr1" [:project :archived] {:name "Site"})]
       :acts [[:stakeholder/set {:person-id "p1" :target {:status "active"}}] [:stakeholder/set {:person-id nil}]
              [:owner-update/post {:text "Shipped." :owner-active true}] [:owner-update/post {:text "" :owner-active true}]
              [:outreach/send {:target {:id "p1" :name "Ana" :status "active"} :note "Hi"}] [:outreach/send {:target {:id "p1" :name "Ana" :status "active"}}]
              [:gap/file {:gap-id "g_1" :idea-id "§gap/x"}]
              [:baton/start {:session-id "s1" :to "p1" :public-title "T" :goal "G"}]
              [:spec/freeze {:frozen true}] [:placement/edit {:owner-hidden true}]]})))

(deftest watch-matrix
  (clean! "watch"
    (run "watch" "watch/pr1"
      {:starts [{:project-id "pr1" :tick-ms 0}]
       :drive [(moved "project" "project/pr1" [:project :has-overseer :active] {:name "Site"})
               (moved "project" "project/pr1" [:project :has-overseer :archived] {:name "Site"})
               [:facts/changed {:ceiling {:autonomy "L0" :reason "Capped."} :look-hint "Read the decisions."}] [:facts/changed {:ceiling nil :look-hint nil}]
               [:reason/noted {:kind "baton/done" :params {:title "T"} :key "k1" :by "system"}]
               [:turn/started {:look false}] [:turn/ended {}] [:org/attached-here {}] [:fire 60000] [:look/finished {}]
               [:look/stopped {:detail "x"}] [:settings/changed {:settings {:caps {:unattended-per-day 0}}}] [:day/rollover {}]]
       :acts [[:operator/run-now {}] [:operator/level-set {:resume-at "L2"}]]
       :key (fn [d] [(count (:reasons d)) (:looks-today d)])})))

(def baton-start {:org-id "o1" :project-id "pr1" :session-id "s1" :public-title "T" :goal "G" :owner {:overseer-of "pr1"}
                  :names names :operator-name "Omar" :messages-max 2})

(defn- baton-matrix [label start & [more-drives]]
  (let [ana {:id "p1" :name "Ana" :status "active"} bob {:id "p2" :name "Bob" :status "active"}]
    (clean! label
      (run "baton" "baton/o1/s1"
        {:starts [start]
         :drive (into [[:reply/writing {}] [:reply/ended {}] [:fire 900000] (moved "person" "person/o1/p1" [:person :left] {:name "Ana"})
                 [:wrapup/finished {}] [:wrapup/stopped {:detail "x"}]]
                (vec more-drives))
         :acts [[:baton/hand-to {:target bob :chosen true :question "Q"}] [:baton/hand-to {:target {:id "operator"} :question "Q"}]
                [:baton/goal-done {:summary "S"}] [:baton/message {:from "p1" :active true}] [:baton/message {:from "p2" :active true}]
                [:baton/message {:from "operator"}] [:baton/take-back {}] [:baton/handoff {:target bob :question "Q"}]
                [:baton/offer {:targets [ana bob] :question "Q"}] [:baton/withdraw {}] [:baton/close {:reason "r" :owner-project "pr1"}]
                [:baton/extend {:more 5}] [:baton/extend {:more 1000}] [:baton/wrapup-retry {}]
                [:baton/record-decision {:decision-id "s1:e1" :area "A" :statement "S" :quote "Q" :owner-areas []}]]
         ;; messages used up to 2 (the start's limit): past it only the budget region matters (a working
         ;; Extend raises the limit without bound, and the raw count would make every Extend a new state)
         :key (fn [d] [(min 2 (get-in d [:budget :messages-used] 0)) (:holder d) (some? (:pending-move d))])
         :max-configs 6000}))))

;; One shard per start kind (each explores from scratch; together they are the enumeration)
(deftest baton-matrix-to-a-person (baton-matrix "baton, to a person" (assoc baton-start :to "p1")))
(deftest baton-matrix-to-the-operator (baton-matrix "baton, to the operator" (assoc baton-start :to "operator")))
(deftest baton-matrix-an-offer (baton-matrix "baton, an offer to a pool" (assoc baton-start :targets ["p1" "p2"])))
(deftest baton-matrix-an-offer-in-hours
  ;; r12: the generator's clock is 1970-01-01 00:16:40 UTC; Bo's window opens at 01:00 (a reach timer),
  ;; and his hours change while he waits (re-armed, or reached at once when cleared)
  (let [bo-hours {:days [0 1 2 3 4 5 6] :from "01:00" :to "02:00"}]
    (baton-matrix "baton, an offer reaching each invitee in their hours (r12)"
      (assoc baton-start :targets ["p1" "p2"] :target-people [{:id "p1" :name "Ana" :status "active"}
                                                             {:id "p2" :name "Bob" :status "active" :tz "UTC" :hours bo-hours}])
      [[:fire 2700000]
       (moved "person" "person/o1/p2" [:person :active] {:name "Bob" :tz "UTC" :hours (assoc bo-hours :from "03:00")})
       (moved "person" "person/o1/p2" [:person :active] {:name "Bob"})])))
(deftest baton-matrix-no-link (baton-matrix "baton, no link minted" (assoc baton-start :to "p1" :mint-link false)))
(deftest baton-matrix-a-settle-session
  (baton-matrix "baton, a conflict's settle session" (assoc baton-start :to "p1" :mint-link false :conflict {:id "cf1" :area "A"})))

(deftest decision-matrix
  (clean! "decision"
    (run "decision" "decision/o1/pr1/d1"
      {:starts [{:org-id "o1" :project-id "pr1" :id "d1" :area "A" :owner-area "none" :statement "S"}]
       :drive [[:reconcile/result {:state "drafted"}] [:reconcile/result {:state "conflict"}] [:reconcile/result {:state "superseded"}]
               [:promote/done {:text-hash "h"}] [:spec/facts {:edited-in-spec true}] [:spec/facts {:record-present false}] [:spec/facts {:build "built"}]]
       :acts [[:decision/owner-area {:owner-area "pay" :owner-areas ["pay"]}] [:decision/owner-area {:owner-area "x" :owner-areas ["pay"]}]
              [:decision/settle-text {:action "keep" :text-hash "h2"}] [:decision/settle-text {:action "restore"}]]})))

(deftest reconciler-matrix
  (clean! "reconciler"
    (run "reconciler" "reconciler/o1/pr1"
      {:starts [{:org-id "o1" :project-id "pr1"} {:org-id "o1" :project-id "pr1" :enabled false}]
       :drive [(moved "decision" "decision/o1/pr1/d1" [:decision :drafted] {:state "drafted" :author-owns-area true :name "Ana"})
               [:reconcile/finished {:decisions []}] [:reconcile/finished {:error "e"}] [:fire 2000] [:settings/reconcile {:on true}]]
       :acts [[:reconcile/request {:delay-ms 0}] [:reconcile/request {:delay-ms 2000}] [:decision/promote {:ids ["d1"]}]
              [:decision/promote {:ids []}] [:decision/promote {:ids ["zz"]}] [:draft/rewrite {}] [:correct/clear-failed {:reason "r"}]]})))

(deftest conflict-matrix
  (let [c {:org-id "o1" :project-id "pr1" :id "cf1" :area "A" :a {:id "d1" :name "Ana"} :b {:id "d2" :name "Bob"} :baton-session-id "s9"}]
    (clean! "conflict"
      (run "conflict" "conflict/o1/pr1/cf1"
        {:starts [(assoc c :routed-to "p1") (assoc c :routed-to "operator") (assoc c :route-error "x")]
         :drive [(moved "baton" "baton/o1/s9" [:baton :closed]) [:conflict/resolved {:outcome "a"}]]
         :acts [[:conflict/reroute (fn [d] {:to "operator" :session-id (str (:baton-session-id d) "r")})] [:conflict/reroute {:to "p2" :target {:status "left"}}]
                [:conflict/settle {:keep "a"}] [:conflict/settle {:statement ""}] [:conflict/settle {}]]}))))

(deftest item-matrix
  (let [ex (fn [lvl] {:settings {:autonomy lvl}})]
    (clean! "item"
      (run "item" "item/o1/pr1/g_1"
        {:starts [{:org-id "o1" :project-id "pr1" :id "g_1" :idea-id "§gap/x" :stall-after-ms {:open 1000}}]
         :drive [(moved "watch" "watch/pr1" [:watch] (ex "L0"))
                 (moved "baton" "baton/o1/b1" [:baton :open :with-person] {:decisions []})
                 ;; with the operator: waiting on them, then answered by them (coordinator-38)
                 (moved "baton" "baton/o1/b1" [:baton :open :with-operator] {:decisions [] :needs-you true})
                 (moved "baton" "baton/o1/b1" [:baton :open :with-operator] {:decisions [] :needs-you false})
                 (moved "baton" "baton/o1/b1" [:baton :done] {:decisions ["d1"]})
                 (moved "decision" "decision/o1/pr1/d1" [:decision :pending] {:state "pending"})
                 (moved "decision" "decision/o1/pr1/d1" [:decision :promoted] {:state "promoted"})
                 (moved "build" "build/pr1/c1" [:build :working] {:decisions ["d1"]})
                 (moved "build" "build/pr1/c1" [:build :merged] {:decisions ["d1"]})
                 [:fire 1000]]
         :acts [[:gather/start (fn [d] {:session-id (str "n" (count (:batons d))) :to "p1" :public-title "T" :goal "G" :question "Q"})]
                [:gather/plan {:to "p1" :public-title "T" :goal "G" :question "Q"}]
                [:build/start (fn [d] {:session-id (str "m" (count (:builds d)))})] [:build/start {:session-id "c3" :decisions ["zz"]}]
                [:gap/drop {}] [:item/hold {}] [:item/resume {}]
                [:correct/reopen {:reason "r"}] [:correct/skip-stall {:reason "r"}] [:correct/relink {:reason "r" :session "baton/o1/b1" :to-item "item/o1/pr1/g_2"}]]
         :max-configs 6000}))))

(deftest build-matrix
  (clean! "build"
    (run "build" "build/pr1/c1"
      {:starts [{:project-id "pr1" :session-id "c1" :kind "coding" :title "T" :prompt "P"}]
       :drive [[:effect/done {:kind "make-worktree" :result {:branch "sova/t" :target "main"}}]
               [:effect/done {:kind "make-worktree" :result {:in-root "x"}}] [:effect/failed {:kind "make-worktree" :detail "x"}]
               [:effect/done {:kind "set-mode"}] [:effect/done {:kind "first-prompt"}] [:turn/started {}] [:turn/ended {}]
               [:workers/changed {:n 1}] [:workers/changed {:n 0}] [:git/probe {:branch "merged"}] [:git/probe {:tree "missing"}]
               [:effect/done {:kind "merge" :result {:commit "c"}}] [:effect/failed {:kind "merge" :detail "No."}]
               [:effect/done {:kind "remove-worktree"}]]
       :acts [[:build/prompt {:text "go"}] [:build/prompt {:text " "}] [:build/merge {}] [:build/remove-worktree {}]
              [:correct/merged {:commit "c" :reason "r"}]]
       :max-configs 6000})))

(deftest runtime-matrix
  ;; a solo world: the registry of a project in no organization; its reasons go to the watch, its run is a build
  (let [files [{:path "bb.edn" :sha "a1"}]
        obs   (fn [m] [:runtime/observed (merge {:commit "c1" :suite 2 :sources {:paths ["bb.edn"] :files files :fingerprint "f1"}} m)])
        h1    {:state "present" :hash "h1"}
        bm    (fn [states ex] (moved "build" "build/pr1/o1" states ex))]
    (clean! "runtime"
      (run "runtime" "runtime/pr1"
        {:starts [{:project-id "pr1" :root "/r"}]
         :drive [(obs {:def {:state "absent"}}) (obs {:def h1 :approved nil :proof nil}) (obs {:def h1 :approved {:hash "h1"} :proof nil})
                 (obs {:def h1 :approved {:hash "h1"} :proof {:hash "h1" :suite 2 :pass true :confined false :at 1}})
                 (obs {:def h1 :approved {:hash "h1"} :proof {:hash "h1" :suite 2 :pass true :confined false :at 1}
                       :sources {:paths ["bb.edn"] :files [{:path "bb.edn" :sha "a2"}] :fingerprint "f2"}})
                 (obs {:def {:state "invalid" :error "bad"}})
                 [:effect/done {:kind "approve" :result {:hash "h1"}}] [:effect/failed {:kind "approve" :detail "The definition changed since it was shown: look again."}]
                 [:effect/done {:kind "conform" :result {:hash "h1" :suite 2 :pass false :confined false :at 2 :failed {:check "ready" :detail "x"}}}]
                 [:effect/failed {:kind "conform" :detail "x"}]
                 [:playbook/started {:sid "build/pr1/o1" :session-id "o1" :started-by "overseer" :why "w"}]
                 [:runtime/observed {:branch-facts {:ref "sova/v" :def {:state "present" :hash "hb"} :approved false}}]
                 (bm [:build :turn-idle :no-commits] {:last-turn-at 5 :running false :branch-state "no-commits"})
                 (bm [:build :turn-idle :unmerged] {:last-turn-at 5 :running false :branch-state "unmerged" :branch "sova/v"})
                 (bm [:build :working :unmerged] {:last-turn-at 5 :running true :branch-state "unmerged"})
                 (bm [:build :merged] {:branch-state "merged"})
                 (bm [:build :tree-removed] {})]
         :acts [[:runtime/approve {:hash "h1"}] [:runtime/approve {:hash "hb"}] [:runtime/approve {:hash "h0"}]]
         :key (fn [d] [(:standing d) (some? (:registered d)) (some? (:drift d)) (some? (:conform-result d)) (some? (:cleared-at d))
                       (some? (get-in d [:playbook :branch-facts])) (get-in d [:playbook :result])])
         :max-configs 6000}))))

(deftest every-statechart-has-its-own-world
  (is (= (set (keys registry/statecharts)) (set (keys worlds))))
  (is (not-any? #(contains? % "watch/") (vals worlds)) "a blank project (the ledger bug) is in no world"))
