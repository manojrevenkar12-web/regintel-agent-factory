/** Hash routes: #/sources, #/incidents/<id>, #/impact/<id>, #/compliance/<run>~<procedure>, #/results. */
import { useEffect, useState } from "react";

export type Route = {
  screen: "sources" | "incidents" | "impact" | "compliance" | "results";
  id: string | null;
};

export function parse(hash: string): Route {
  const [, screen, ...rest] = hash.replace(/^#/, "").split("/");
  const s =
    (["sources", "incidents", "impact", "compliance", "results"] as const).find((x) => x === screen) ??
    "sources";
  return { screen: s, id: rest.length ? decodeURIComponent(rest.join("/")) : null };
}

export const href = (screen: Route["screen"], id?: string) =>
  `#/${screen}${id ? `/${encodeURIComponent(id)}` : ""}`;

export function useRoute(): Route {
  const [r, setR] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setR(parse(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}
