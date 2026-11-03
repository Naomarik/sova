// The spec tools' tokenizer and stemmer (pi-config/extensions/spec/core/topic.mjs), typed. Imported,
// never rewritten: the bench must not grow a third tokenizer.
// @ts-ignore: topic.mjs is plain JS with no declaration file
import * as topic from "../../pi-config/extensions/spec/core/topic.mjs";

export const termsOf: (text: string) => string[] = topic.termsOf;
export const wordsOf: (text: string) => { term: string; word: string }[] = topic.wordsOf;
export const stem: (word: string) => string = topic.stem;
