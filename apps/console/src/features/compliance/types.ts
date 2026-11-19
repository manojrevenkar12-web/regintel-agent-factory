export type Verdict = "covered" | "partial" | "conflict" | "missing";

export type Run = {
  id: string;
  world: string;
  version: number;
  design: string;
  summary: {
    procedures: number;
    findings: number;
    verdicts: Record<Verdict, number>;
    routes: Record<string, number>;
  };
};

export type ProcedureRow = {
  id: string;
  customer: string;
  device: string;
  title: string;
  verdicts: Partial<Record<Verdict, number>> | null;
  open: number;
};

export type Requirement = {
  id: string;
  text: string;
  days: number | null;
  months: number | null;
  sources: { ref: string; clause: string; text: string }[];
};

export type Finding = {
  id: string;
  body_hash: string;
  requirement: Requirement;
  body: {
    verdict: Verdict;
    steps: string[];
    quotes: string[];
    coverage: number;
    reasons: string[];
    route: "auto" | "review" | "ruling";
  };
  reviews: {
    seq: number;
    reviewer: string;
    role: string;
    decision: string;
    verdict: Verdict;
    steps: string[];
    note: string;
    at: string;
  }[];
};

export type Detail = {
  procedure: {
    id: string;
    customer: string;
    device: string;
    title: string;
    steps: { id: string; text: string }[];
  };
  findings: Finding[];
};

export const VERDICTS: Verdict[] = ["covered", "partial", "conflict", "missing"];

export const verdictWords: Record<Verdict, string> = {
  covered: "Met",
  partial: "Met in part",
  conflict: "Contradicted",
  missing: "Not in the procedure",
};

/** Colour carries the verdict only next to its words, never alone. */
export const verdictTone: Record<Verdict, { text: string; wash: string; bar: string }> = {
  covered: { text: "text-verified", wash: "bg-verifiedWash", bar: "bg-verified" },
  partial: { text: "text-attention", wash: "bg-attentionWash", bar: "bg-attention" },
  conflict: { text: "text-fault", wash: "bg-faultWash", bar: "bg-fault" },
  missing: { text: "text-fault", wash: "bg-faultWash", bar: "bg-line" },
};

/** The verdict a reader should trust: the latest review's, else the platform's. */
export const current = (f: Finding): Verdict => f.reviews.at(-1)?.verdict ?? f.body.verdict;
export const needsReview = (f: Finding) => f.body.route === "review" && f.reviews.length === 0;
