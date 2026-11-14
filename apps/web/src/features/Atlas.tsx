import { useEffect, useRef, useState } from "react";
import { MUSCLE_ART } from "../lib/muscleArt.js";

/** One body view at a time, swapping front/back as the hovered muscle needs,
 *  exactly like the Python dashboard. The artwork ids are anatomical names, so
 *  the only way to paint the right shapes is the MUSCLE_ART map.
 *
 *  Three groups (serratus, lower back, hip flexors) have no artwork in this
 *  atlas: hovering them dims the figure and paints nothing. That is content we
 *  do not have, not a bug to paper over.
 */
const cache = new Map<string, string>();

async function load(view: string): Promise<string> {
  const hit = cache.get(view);
  if (hit !== undefined) return hit;
  try {
    const response = await fetch(`/art/muscle-${view}.svg`, { cache: "force-cache" });
    const text = await response.text();
    cache.set(view, text);
    return text;
  } catch {
    cache.set(view, "");
    return "";
  }
}

export function Atlas({ active }: { active: string | null }) {
  const host = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [view, setView] = useState<"front" | "back">("front");
  const [pending, setPending] = useState(false);

  // paint the hovered muscle into whatever markup is currently mounted
  const paint = (slug: string | null) => {
    const box = host.current;
    if (!box) return;
    box.querySelectorAll(".on").forEach((el) => el.classList.remove("on"));
    const art = slug ? MUSCLE_ART[slug] : null;
    if (!art) return;
    for (const id of art.ids) {
      const el = box.querySelector(`#${CSS.escape(id)}`);
      if (el) el.classList.add("on");
    }
  };

  // load the current view's artwork once, then re-paint: the swap wipes the
  // highlight, and hovering a muscle in the other view must not go dark
  useEffect(() => {
    let cancelled = false;
    void load(view).then((svg) => {
      if (cancelled || !host.current) return;
      host.current.innerHTML = svg;
      paint(activeRef.current);
    });
    return () => { cancelled = true; };
  }, [view]);

  // pick the view the hovered muscle lives in
  useEffect(() => {
    const art = active ? MUSCLE_ART[active] : null;
    setPending(Boolean(active) && !art);
    if (art && art.view !== view) setView(art.view);
    else paint(active);
  }, [active, view]);

  return (
    <figure className={`body${pending ? " pending" : ""}`}>
      <div ref={host} />
      <figcaption>
        Art: Ryan Graves · CC BY 4.0
        {pending ? <><br />no artwork for this group</> : null}
      </figcaption>
    </figure>
  );
}
