// An introduction for AV works. JavDB and Jable carry no plot text, and the sites that do sit
// behind bot checks, so the intro is the full original title (for JAV that is the premise) plus
// one line built from the facts: cast, studio, length, genres.
export function avIntro(title: string, facts: { people?: string[]; studio?: string; minutes?: number; tags?: string[] }): string {
  const line = [
    facts.people?.length ? `${facts.people.slice(0, 4).join("、")} 主演` : "",
    facts.studio ? `${facts.studio} 出品` : "",
    facts.minutes ? `片长 ${facts.minutes} 分钟` : "",
  ].filter(Boolean).join("，");
  const tags = facts.tags?.length ? `类别：${facts.tags.slice(0, 8).join("、")}。` : "";
  return [title.trim(), [line && `${line}。`, tags].filter(Boolean).join("")].filter(Boolean).join("\n\n");
}
