import { useEffect } from "react";
import { ImpactScreen } from "./features/impact/ImpactScreen";
import { IncidentsScreen } from "./features/incidents/IncidentsScreen";
import { ResultsScreen } from "./features/results/ResultsScreen";
import { SourcesScreen } from "./features/sources/SourcesScreen";
import { useResource } from "./shared/api";
import { type Route, href, useRoute } from "./shared/route";
import { DEMO_PEOPLE, roleName, useSession } from "./shared/session";

const NAV: { screen: Route["screen"]; label: string }[] = [
  { screen: "sources", label: "Sites" },
  { screen: "incidents", label: "Incidents" },
  { screen: "impact", label: "Change impact" },
  { screen: "results", label: "Results" },
];

export function App() {
  const route = useRoute();
  const { setup, setSetup, who, setWho } = useSession();
  const setups = useResource<{ setup: string }[]>("/api/setups");
  // start on a season that exists: the one asked for if it ran, else the first that did
  useEffect(() => {
    const names = (setups.data ?? []).map((s) => s.setup);
    if (names.length && !names.includes(setup)) setSetup(names[0] as string);
  }, [setups.data, setup, setSetup]);
  return (
    <div className="min-h-screen">
      <a href="#main" className="sr-only focus:not-sr-only">
        Skip to content
      </a>
      <header className="border-b border-line bg-sheet">
        <div className="mx-auto flex max-w-page flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
          <p className="m-0 font-text text-lead font-semibold">Regulatory agent factory</p>
          <nav aria-label="Main">
            <ul className="m-0 flex list-none flex-wrap gap-6 p-0">
              {NAV.map((n) => (
                <li key={n.screen}>
                  <a
                    href={href(n.screen)}
                    aria-current={route.screen === n.screen ? "page" : undefined}
                    className={`border-b-rule pb-1 ${route.screen === n.screen ? "border-ink font-bold" : "border-transparent text-muted hover:text-ink"}`}
                  >
                    {n.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <div className="ml-auto flex flex-wrap items-center gap-4 text-small">
            <label className="flex items-center gap-2">
              Season
              <select
                value={setup}
                onChange={(e) => setSetup(e.target.value)}
                className="rounded-soft border border-line bg-sheet px-2 py-1"
              >
                {(setups.data?.length ? setups.data.map((s) => s.setup) : [setup]).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              Signed in as
              <select
                value={who.id}
                onChange={(e) => setWho(DEMO_PEOPLE.find((p) => p.id === e.target.value) ?? who)}
                className="rounded-soft border border-line bg-sheet px-2 py-1"
              >
                {DEMO_PEOPLE.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}, {roleName(p.role)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-page px-4 py-8">
        {route.screen === "sources" && <SourcesScreen />}
        {route.screen === "incidents" && <IncidentsScreen id={route.id} />}
        {route.screen === "impact" && <ImpactScreen id={route.id} />}
        {route.screen === "results" && <ResultsScreen />}
      </main>
    </div>
  );
}
