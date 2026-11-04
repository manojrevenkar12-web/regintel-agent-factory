/** Who is using the console, and which season setup they are looking at. In production the identity
 * comes from the sign-in proxy; here a person picks one of the demo identities. */
import { type ReactNode, createContext, useContext, useState } from "react";
import type { Identity } from "./api";

export const DEMO_PEOPLE: Identity[] = [
  { id: "u-ra-01", name: "Dana Weber", role: "regulatory_affairs" },
  { id: "u-qa-02", name: "Tobias Lang", role: "quality_assurance" },
  { id: "u-eng-03", name: "Mira Okafor", role: "platform_engineer" },
];

type Session = { setup: string; setSetup: (s: string) => void; who: Identity; setWho: (p: Identity) => void };
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [setup, setSetup] = useState("sonnet-gated");
  const [who, setWho] = useState<Identity>(DEMO_PEOPLE[0] as Identity);
  return <Ctx.Provider value={{ setup, setSetup, who, setWho }}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export const roleName = (r: string) => r.replace(/_/g, " ");
