import { useEffect, useRef } from "react";

/** The vendored body atlas (Ryan Graves, CC BY 4.0).
 *
 * Two SVGs are fetched once and inlined so a hover can paint one group by id.
 * The CSS in dashboard.css does the painting: `.body svg [id].on{fill:accent}`.
 * Serratus, lower back and hip flexors have no artwork — they stay pending and
 * must not be faked.
 */
export function Atlas({ active }: { active: string | null }) {
  const front = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const [f, b] = await Promise.all([
        fetch("/art/muscle-front.svg").then((r) => r.text()),
        fetch("/art/muscle-back.svg").then((r) => r.text()),
      ]);
      if (cancelled) return;
      if (front.current) front.current.innerHTML = f;
      if (back.current) back.current.innerHTML = b;
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    for (const host of [front.current, back.current]) {
      if (!host) continue;
      host.querySelectorAll("[id].on").forEach((el: Element) => el.classList.remove("on"));
      if (!active) continue;
      const exact = host.querySelector(`[id="${active}"]`);
      if (exact) {
        exact.classList.add("on");
        continue;
      }
      // some groups are drawn as a family (e.g. quad heads); paint what matches
      host.querySelectorAll(`[id^="${active}-"], [id$="-${active}"]`)
        .forEach((el: Element) => el.classList.add("on"));
    }
  }, [active]);

  return (
    <div className="bodyart">
      <div ref={front} />
      <div ref={back} />
    </div>
  );
}
