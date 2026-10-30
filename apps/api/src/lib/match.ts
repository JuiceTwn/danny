// How Danny decides which notes matter to what was just said. Plain code, nothing leaves the server and nothing is billed.

const STOP = new Set("the and for are but not you your with that this from have has had was were will would can could should about they them their then than into out one all any our his her she him its who what when where which while also just very more most some such only over under after before been being does did doing there here these those how why".split(" "));
/** Whole lowercase words of 3+ letters, minus filler. Used for spotting duplicates, so it does not stem. */
export const words = (s: string) => [...new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];

const DOUBLE = /([bdgmnprt])\1$/; // running -> runn -> run; not "calling" -> "call"

/** A light stemmer: texts/text, moving/moved/move, married/marry, parties/party all meet in the middle. */
export function stem(word: string) {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (/(sses|xes|ches|shes)$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3).replace(DOUBLE, "$1");
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2).replace(DOUBLE, "$1");
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("y")) w = `${w.slice(0, -1)}i`;
  return w;
}

/** Words that mean nearly the same thing to a person, so "my brother" finds the note about a sister. Deliberately small. */
const GROUPS = [
  "family sister brother sibling mom mum mother dad father parent wife husband spouse partner son daughter kid child grandma grandmother grandpa grandfather aunt uncle cousin niece nephew",
  "wedding married marry marriage engaged engagement fiance fiancee bride groom anniversary",
  "job work employer boss manager office career colleague coworker company shift salary hired",
  "home house apartment rent landlord lease mortgage address move live neighbourhood neighborhood",
  "food eat diet vegetarian vegan lunch dinner breakfast restaurant cook meal coffee",
  "health doctor dentist medication medicine allergic allergy sick pharmacy",
  "money pay budget bill price cost afford bank salary rent",
  "travel trip flight holiday vacation visit hotel airport",
  "car drive vehicle truck van",
  "pet dog cat puppy kitten vet",
  "school college university class study course exam degree student",
  "contact call phone text message email reach",
  "music guitar piano band song instrument",
];
const CONCEPT = new Map<string, string[]>();
GROUPS.forEach((g, i) => {
  for (const w of g.split(" ")) {
    const s = stem(w);
    CONCEPT.set(s, [...(CONCEPT.get(s) ?? []), `~${i}`]);
  }
});

export type Terms = { stems: Set<string>; concepts: Set<string> };
export function terms(s: string): Terms {
  const stems = new Set(words(s).map(stem));
  const concepts = new Set<string>();
  for (const t of stems) for (const c of CONCEPT.get(t) ?? []) concepts.add(c);
  return { stems, concepts };
}

const CONCEPT_WEIGHT = 0.6;
const CONTEXT_WEIGHT = 0.5;
const SUBJECT_BOOST = 2;
const DAY = 86_400_000;

export type Query = { now: Terms; context: Terms };
/** What was just said, plus a little of what was said just before it ("what about her?" still finds Priya). */
export const queryOf = (message: string, context: string[] = []): Query => ({ now: terms(message), context: terms(context.join(" ")) });
export const emptyQuery = (q: Query) => !q.now.stems.size && !q.context.stems.size;

const overlap = (a: Terms, b: Terms) => {
  let n = 0;
  for (const t of a.stems) if (b.stems.has(t)) n++;
  let c = 0;
  for (const t of a.concepts) if (b.concepts.has(t)) c++;
  return n + CONCEPT_WEIGHT * c;
};

export type Candidate = { text: string; subject: string | null; kind: string; updatedAt: string; usedAt?: string | null; expiresAt: string | null };

/**
 * 0 means "not related". Anything above is related, and bigger is more so. Recency, recent use and an approaching date only
 * ever break ties between notes that already match; they never make an unrelated note appear.
 */
export function score(c: Candidate, q: Query, now = Date.now()) {
  const t = terms(c.text);
  let s = overlap(q.now, t) + CONTEXT_WEIGHT * overlap(q.context, t);
  if (c.subject) {
    const subj = terms(c.subject).stems;
    if ([...subj].some((w) => q.now.stems.has(w))) s += SUBJECT_BOOST;
    else if ([...subj].some((w) => q.context.stems.has(w))) s += SUBJECT_BOOST * CONTEXT_WEIGHT;
  }
  if (s <= 0) return 0;
  const age = (now - Date.parse(c.updatedAt)) / DAY;
  s += age < 14 ? 0.3 : age < 60 ? 0.15 : 0;
  if (c.usedAt && (now - Date.parse(c.usedAt)) / DAY < 14) s += 0.15;
  if (c.kind === "plan" && c.expiresAt) {
    const ahead = (Date.parse(c.expiresAt) - now) / DAY;
    if (ahead >= 0 && ahead < 14) s += 0.4;
  }
  return s;
}
