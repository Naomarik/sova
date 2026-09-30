(ns sova.statecharts.engine.matrix-test
  "The matrix generator on the refit probe statechart: a clean statechart passes, and a statechart whose explain
   disagrees with its guards is caught."
  (:require
    [cljs.test :refer [deftest is]]
    [sova.statecharts.engine.matrix :as matrix]
    [sova.statecharts.engine.refit-probe :as rp]))

(def envelopes
  {"operator"        {:by "operator"}
   "attended"        {:by "overseer" :attended true :level "L0" :project-id "p1"}
   "L0"              {:by "overseer" :level "L0" :project-id "p1"}
   "L3"              {:by "overseer" :level "L3" :project-id "p1" :hold-ms 0}
   "L3-held"         {:by "overseer" :level "L3" :project-id "p1"}
   "capped-day"      {:by "overseer" :level "L3" :project-id "p1" :hold-ms 0 :allowance {:gather {:used 6 :max 6}}}
   "capped-at-once"  {:by "overseer" :level "L3" :project-id "p1" :hold-ms 0 :at-once {:gatherings-open 5 :gatherings-cap 5}}
   "with-reason"     {:by "overseer" :level "L3" :project-id "p1" :reason "wrong phase"}})

(def acts
  [[:gather/start {:to "ana"}] [:gather/close {}] [:item/reopen {}] [:kid/spawn {:name "k"}]
   [:kid/spawn {}] [:door/open {}] [:door/open {:door "bad"}] [:decision/promote {:ids ["d1"]}]
   [:build/start {}] [:hold/cancel {:id "gather/start#0"}]])

(deftest the-probe-statechart-is-clean
  (let [r (matrix/run {:statecharts rp/statecharts :statechart "refit-parent" :level-check rp/level-check
                       :acts acts :envelopes envelopes
                       :key (fn [d] (set (map :kind (vals (:sova/holds d)))))
                       :drive [[:timed/arm {}] [:fire 600000] [:fire 1000]]})]
    (is (empty? (:failures r)) (pr-str (take 3 (:failures r))))
    (is (not (:truncated r)))
    (is (<= 4 (:configs r)) "idle, gathering, timed and held states are reached")
    (is (= (* (:configs r) (count acts) (count envelopes)) (:cells r)))
    (is (pos? (:accepted r)))
    (is (pos? (:refused r)))
    (is (contains? (:reached r) #{:top :gathering}))))

(deftest a-disagreeing-explain-is-caught
  ;; an impure pre check (it refuses every other time it runs) makes explain and the send disagree
  (let [calls  (atom 0)
        flaky  {:name :flaky :fn (fn [_] (when (= 1 (swap! calls inc)) "Flaky."))}
        statecharts (assoc-in rp/statecharts ["refit-parent" :acts :door/open :pre] [flaky])
        r      (matrix/run {:statecharts statecharts :statechart "refit-parent" :level-check rp/level-check
                            :acts [[:door/open {}]] :envelopes {"operator" {:by "operator"}}})]
    (is (seq (:failures r)))
    (is (every? #{"taken, but explain refuses" "refused, but explain is nil" "the send's sentence differs from explain's"}
          (map :why (:failures r))))))

(deftest sentences-outside-the-catalogue-are-caught
  (let [r (matrix/run {:statecharts rp/statecharts :statechart "refit-parent" :level-check rp/level-check
                       :acts [[:gather/close {}]] :envelopes {"operator" {:by "operator"}}
                       :sentences #{"something else"}})]
    (is (= ["a sentence outside the catalogue"] (distinct (map :why (:failures r)))))))

(deftest the-world-must-be-declared
  (let [go (fn [world] (matrix/run {:statecharts rp/statecharts :statechart "refit-parent" :level-check rp/level-check :sid "par/o1/1"
                                    :acts [[:kid/spawn {:name "k"}]] :envelopes {"operator" {:by "operator"}}
                                    :drive [[:kid/watch {:target "kid/nowhere"}]] :world world}))]
    (let [r (go nil)]
      (is (= #{"kid/nowhere"} (:absorbed r)))
      (is (= ["sent to a session outside the world"] (distinct (map :why (:failures r))))
        "absorbing an unknown session is a failure unless the world names it"))
    (is (empty? (:failures (go #{"kid/nowhere"}))))))

(deftest a-drive-or-explain-that-throws-fails
  (let [r (matrix/run {:statecharts rp/statecharts :statechart "refit-parent" :level-check rp/level-check
                       :acts [] :envelopes {} :drive [[:probe/boom (fn [_] (throw (js/Error. "boom")))]]})]
    (is (= [{:why "a drive threw" :error "boom"}] (map #(select-keys % [:why :error]) (:failures r)))))
  (let [statecharts (assoc-in rp/statecharts ["refit-parent" :not-here] (fn [_ _ _] (throw (js/Error. "not-here threw"))))
        r      (matrix/run {:statecharts statecharts :statechart "refit-parent" :level-check rp/level-check
                            :acts [[:gather/close {}]] :envelopes {"operator" {:by "operator"}}})]
    (is (= "explain threw" (:why (first (:failures r)))))))

(deftest envelopes-may-be-fns-of-the-state
  (let [r (matrix/run {:statecharts rp/statecharts :statechart "refit-parent" :level-check rp/level-check
                       :acts [[:gather/start {:to "a"}]]
                       :envelopes {"stamped" (fn [d] {:by "overseer" :level (if (:gathers d) "L0" "L3") :project-id "p1" :hold-ms 0})}})]
    (is (empty? (:failures r)))
    (is (pos? (:accepted r)))
    (is (pos? (:refused r)) "the second state's stamp refuses")))

(deftest payloads-may-be-fns-of-the-state
  (let [r (matrix/run {:statecharts rp/statecharts :statechart "refit-parent" :level-check rp/level-check
                       :acts [[:kid/spawn (fn [d] {:name (str "k" (count (:sova/children d)))})]]
                       :envelopes {"operator" {:by "operator"}}
                       :key (fn [d] (count (:sova/children d))) :max-configs 3})]
    (is (empty? (:failures r)) "a fresh id per state: no spawn of an existing id")
    (is (= 3 (:configs r)))))

(deftest a-payload-key-that-shadows-the-envelope-fails-its-cell
  ;; baton/extend's `by`: merged, the envelope's actor would hide the payload's count (the host throws)
  (let [r (matrix/run {:statecharts rp/statecharts :statechart "refit-parent" :level-check rp/level-check
                       :acts [[:door/open {:by 5}] [:door/open {:reason "same"}] [:door/open {:reason "other"}] [:door/open {:more 5}]]
                       :envelopes {"operator" {:by "operator" :reason "same"}}})]
    (is (= [[:door/open [:by]] [:door/open [:reason]]]
          (map (juxt :act :keys) (filter #(= "a payload key shadows the envelope's" (:why %)) (:failures r)))))
    (is (= 2 (count (:failures r))) "an equal value and a key only the payload has pass"))
  (is (= [:by :reason] (matrix/shadowed {:reason "a" :by 5 :x 1} {:by "operator" :reason "b" :x 1}))))
