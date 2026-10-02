(ns sova.statecharts.proj-strip-org
  "TEMPORARY: proj v1 → v2, the one-time conversion of the General Projects cutover (removed, with its
   fixture and its line in registry.cljc, once every converted workspace loads clean). A v1 project held
   its organization's concerns; v2 holds none (they are its placement's, born at the org's open). This
   is the only project-layer code that names them, and only to drop them."
  (:require [clojure.string]))

(def org-states
  #{:stake :no-stakeholder :stakeholder-set :stakeholder-cleared
    :milestone :no-milestone :since-post :cooldown :ready :cooling})

(def org-keys
  [:org-id :stakeholder :stakeholder-history :stakeholder-cleared :owner-hidden :spec :last-post-at :milestone])

(def org-events #{:cooldown/over :cooldown/restart :milestone/noted})

(def project-layer #{"project" "watch" "build" "runtime"})

(defn- org-sid? [sid] (not (contains? project-layer (first (clojure.string/split (str sid) #"/")))))

(defn- keep-only [data k f] (if (contains? data k) (update data k f) data))

(defn strip-org
  "proj v1 → v2 (engine/API.md §6): drop the org's states and keys, the org's watcher and link, the
   gatherings in `started`, the org-layer children, and any pending org timer."
  [{:keys [config data history queue]}]
  {:config  (set (remove org-states config))
   :data    (-> (apply dissoc data org-keys)
              (keep-only :sova/watchers (fn [ws] (vec (remove org-sid? ws))))
              (keep-only :sova/links (fn [ls] (into {} (remove (fn [[_ v]] (org-sid? v)) ls))))
              (keep-only :sova/children (fn [cs] (vec (remove #(org-sid? (:sid %)) cs))))
              (keep-only :started (fn [rows] (vec (remove #(org-sid? (:sid %)) rows)))))
   :history (or history {})
   :queue   (vec (remove #(contains? org-events (get-in % [:event :name])) queue))})
