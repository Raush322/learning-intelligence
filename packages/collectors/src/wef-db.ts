import crypto from "node:crypto";

import { prisma } from "@learning-intelligence/database";

import { extractArticle } from "./article-extractor.js";
import { SOURCES } from "./sources.js";
import { translateArticle } from "./translate-article.js";

const LOOKBACK_HOURS = 24;
const ISSUE_TIME_ZONE = "Europe/Moscow";

type SourceConfig = (typeof SOURCES)[number];

type Candidate = {
  sourceSlug: string;
  title: string;
  url: string;
  publishedAt: string | null;
  description: string;
  imageUrl: string | null;
};

type ExtractedArticle = {
  title: string;
  author: string | null;
  publishedAt: string | null;
  imageUrl: string | null;
  text: string;
};

function getMoscowDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ISSUE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function getDateOnly(dateString: string): Date {
  return new Date(`${dateString}T00:00:00.000Z`);
}

async function fetchFeed(url: string): Promise<string> {
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 2000;

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(
        `Fetching RSS feed: ${url} (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/rss+xml,application/atom+xml,application/xml,text/xml",
        },
      });

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
      }

      return await response.text();
    } catch (error) {
      lastError = error;

      console.error(
        `RSS feed request failed (attempt ${attempt}/${MAX_ATTEMPTS}): ${url}`,
      );
      console.error(error);

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAY_MS),
        );
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(String(lastError));
}

function normalizeUrl(url: string, baseUrl: string): string {
  try {
    const parsed = new URL(url, baseUrl);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function cleanTitle(title: string): string {
  return title
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function extractRssImage(
  $: import("cheerio").CheerioAPI,
  element: any,
  baseUrl: string,
): string | null {
  const candidates = [
    $(element).find("enclosure").first().attr("url"),
    $(element).find("media\\:content").first().attr("url"),
    $(element).find("media\\:thumbnail").first().attr("url"),
    $(element).find("content\\:content").first().attr("url"),
    $(element).find("image").first().attr("href"),
    $(element).find("image").first().text().trim(),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      const imageUrl = new URL(candidate, baseUrl);

      if (
        imageUrl.protocol === "http:" ||
        imageUrl.protocol === "https:"
      ) {
        return imageUrl.toString();
      }
    } catch {
      // Игнорируем некорректный URL изображения.
    }
  }

  return null;
}

function cleanXmlText(value: string | undefined): string {
  return cleanTitle(
    (value ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " "),
  );
}

function isInfrastructureCandidate(title: string): boolean {
  const normalized = title.toLowerCase();

  const excludedPatterns = [
    /\bdata cent(er|ers)\b/,
    /\bдата[- ]цент(р|ры)\b/,
    /\bgpu\b/,
    /\btpu\b/,
    /\bcompute\b/,
    /\bcomputing\b/,
    /\binference\b/,
    /\bsemiconductor/,
    /\bchip(s)?\b/,
    /\bчип(ы|ов|ах)?\b/,
    /\benergy for ai\b/,
    /\bai energy\b/,
    /\belectricity.*ai\b/,
    /\bai.*electricity\b/,
    /\bpower grid\b/,
    /\bgrid.*ai\b/,
  ];

  return excludedPatterns.some((pattern) =>
    pattern.test(normalized),
  );
}

function isPromotionalCandidate(title: string): boolean {
  const normalized = title.toLowerCase();

  const strongPromotionalPatterns = [
    /\bfinal \d+ hours?\b/,
    /\b\d+ hours? (left|to)\b/,
    /\b\d+ days? left to\b/,
    /\b\d+ days? to save\b/,
    /\b\d+ days? .*save\b//,
    /\blast chance\b/,
    /\bregister now\b/,
    /\bregistration (is )?open\b/,
    /\btickets?\b/,
    /\bexhibit(ing|or|ors)?\b/,
    /\bsponsor(ing|ed|ship)?\b/,
    /\bapply now\b/,
    /\bapplications? (are )?open\b/,
    /\bcall for speakers\b/,
    /\bbook (a )?table\b/,
    /\bbooth\b/,
    /\bexpo hall\b/,
    /\bside event\b/,
    /\bконференц/,
    /\bвебинар/,
    /\bрегистрац/,
    /\bбилет(ы|ов)?\b/,
    /\bвыстав/,
    /\bэкспонент/,
    /\bспонсор/,
    /\bподать заявку\b/,
    /\bзаявки? (открыт|принима)/,
    /\bдедлайн\b/,
    /\bпоследн\w* (час|дн)/,
    /\bостал\w* (час|дн)/,
    /\bзабронировать\b/,
    /\bстенд\b/,
    /\bэкспозал\b/,
  ];

  if (strongPromotionalPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }

  const savingsAndParticipationPatterns = [
    /\b(?:save|discount|discounted)\b.*\b(?:attend|attendance|ticket|tickets|participat)\b/,
    /\b(?:attend|attendance|ticket|tickets|participat)\b.*\b(?:save|discount|discounted)\b/,
    /\bearly[- ]bird\b/,
    /\blimited[- ]time offer\b/,
  ];

  if (
    savingsAndParticipationPatterns.some((pattern) =>
      pattern.test(normalized),
    )
  ) {
    return true;
  }

  // Generic event/conference wording is not enough by itself.
  // It becomes promotional only when combined with an explicit call to action.
  const genericEventPatterns = [
    /\bconference\b/,
    /\bconference(s)?\b/,
    /\bevent(s)?\b/,
    /\bмероприяти/,
    /\bконференци/,
  ];

  const callToActionPatterns = [
    /\bregister\b/,
    /\bregistration\b/,
    /\bticket/,
    /\battend\b/,
    /\bjoin us\b/,
    /\bsign up\b/,
    /\bapply\b/,
    /\bзапиш/,
    /\bзарегистр/,
    /\bпосет/,
    /\bучаств/,
    /\bsave\b/,
    /\bdiscount\b/,
    /\bdiscounted\b/,
    /\bearly[- ]bird\b/,
  ];

  return (
    genericEventPatterns.some((pattern) => pattern.test(normalized)) &&
    callToActionPatterns.some((pattern) => pattern.test(normalized))
  );
}

function hasAiSignal(title: string, description = ""): boolean {
  const normalizedTitle = title.toLowerCase();
  const normalizedText = `${title} ${description}`.toLowerCase();

  const titlePatterns = [
    /\bartificial intelligence\b/,
    /\bai\b/,
    /\bai[- ]powered\b/,
    /\bai[- ]generated\b/,
    /\bai[- ]driven\b/,
    /\bai[- ]agent(s)?\b/,
    /\bagentic\b/,
    /\bautonomous agent(s)?\b/,
    /\bllm(s)?\b/,
    /\blarge language model(s)?\b/,
    /\bfoundation model(s)?\b/,
    /\b(?:new|frontier|reasoning|multimodal) model(s)?\b/,
    /\bmodel(s)?\s+(?:release|launch|update|training|evaluation)\b/,
    /\bmultimodal\b/,
    /\bmachine learning\b/,
    /\bdeep learning\b/,
    /\bneural network(s)?\b/,
    /\bcomputer vision\b/,
    /\breinforcement learning\b/,
    /\bmodel(s)?\b/,
    /\brobot(s|ics)?\b/,
    /\bhumanoid(s)?\b/,
    /\balignment\b/,
    /\bjailbreak(s|ed)?\b/,
    /\bprompt injection\b/,
    /\bsynthetic (data|media|content)\b/,
    /\bгенеративн/,
    /\bискусственн.*интеллект/,
    /\bмашинн.*обучен/,
    /\bнейросет/,
    /\bмультимодальн/,
    /\bробот(ы|а|ов|ам|ами|ах)?\b/,
    /\bавтономн.*(агент|систем|робот|ai|ии)\b/,
    /\bclaude\b/,
    /\bgemini\b/,
    /\bgpt(?:-\d+(?:\.\d+)?)?\b/,
    /\bopenai\b/,
    /\banthropic\b/,
    /\bdeepmind\b/,
    /\bmistral\b/,
    /\bhugging face\b/,
    /\bmeta ai\b/,
    /\bmicrosoft ai\b/,
  ];

  if (titlePatterns.some((pattern) => pattern.test(normalizedTitle))) {
    return true;
  }

  const textPatterns = [
    /\bartificial intelligence\b/,
    /\bai\b/,
    /\bmachine learning\b/,
    /\blarge language model\b/,
    /\bfoundation model\b/,
    /\bmultimodal\b/,
    /\bllm\b/,
    /\bai agent\b/,
    /\brobotics\b/,
    /\bcomputer vision\b/,
    /\balignment\b/,
    /\bprompt injection\b/,
    /\bгенеративн/,
    /\bискусственн.*интеллект/,
    /\bнейросет/,
    /\bмультимодальн/,
    /\bclaude\b/,
    /\bgemini\b/,
    /\bgpt\b/,
    /\bopenai\b/,
    /\banthropic\b/,
    /\bdeepmind\b/,
  ];

  let matches = 0;

  for (const pattern of textPatterns) {
    if (pattern.test(normalizedText)) {
      matches++;
    }
  }

  return matches >= 2;
}

function isAiFocusedSource(sourceSlug: string): boolean {
  return [
    "google-ai",
    "the-verge-ai",
    "wired-ai",
    "ars-technica-ai",
    "the-decoder",
  ].includes(sourceSlug);
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\\s+/g, " ")
    .trim();
}

function isClearlyAdjacentNonAiContent(title: string): boolean {
  const normalizedTitle = normalizeForMatch(title);

  const patterns = [
    /\bdevfest\b/,
    /\bastronaut\b/,
    /\bspace\b.*\bdiscovery\b/,
    /\bfootball\b/,
    /\bnext big race\b/,
    /\bhome decor\b/,
    /\b70-year love story\b/,
  ];

  return patterns.some((pattern) => pattern.test(normalizedTitle));
}

function isRelevantCandidate(
  title: string,
  description = "",
  sourceSlug?: string,
): boolean {
  if (isInfrastructureCandidate(title)) {
    return false;
  }

  if (isPromotionalCandidate(title)) {
    return false;
  }

  if (isClearlyAdjacentNonAiContent(title)) {
    return false;
  }

  // Specialized AI feeds no longer bypass the deterministic editorial
  // exclusions above. They are accepted after infrastructure, promotional,
  // and clearly-adjacent checks; the topic classifier then refines them.
  if (sourceSlug && isAiFocusedSource(sourceSlug)) {
    return true;
  }

  return hasAiSignal(title, description);
}

function isFresh(
  publishedAt: string | null,
  cutoff: Date,
): boolean {
  if (!publishedAt) {
    return false;
  }

  const publishedDate = new Date(publishedAt);

  if (Number.isNaN(publishedDate.getTime())) {
    return false;
  }

  return publishedDate >= cutoff;
}

async function collectSource(
  source: SourceConfig,
): Promise<Candidate[]> {
  console.log("");
  console.log(`--- SOURCE: ${source.name} ---`);
  console.log(`RSS: ${source.url}`);

  const xml = await fetchFeed(source.url);

  const { load } = await import("cheerio");
  const $ = load(xml, { xmlMode: true });

  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  $("item, entry").each((_, element) => {
    const title = cleanXmlText(
      $(element).find("title").first().text(),
    );

    if (title.length < 10) {
      return;
    }

    const linkElement = $(element).find("link").first();

    let rawUrl = linkElement.attr("href") ?? null;

    if (!rawUrl) {
      rawUrl = linkElement.text().trim() || null;
    }

    if (!rawUrl) {
      rawUrl =
        $(element).find("guid").first().text().trim() || null;
    }

    if (!rawUrl) {
      return;
    }

    const url = normalizeUrl(rawUrl, source.url);

    if (seen.has(url)) {
      return;
    }

    const publishedAt =
      $(element).find("pubDate").first().text().trim() ||
      $(element).find("published").first().text().trim() ||
      $(element).find("updated").first().text().trim() ||
      $(element).find("dc\\:date").first().text().trim() ||
      null;

    const description = cleanXmlText(
      $(element).find("description").first().text() ||
        $(element).find("summary").first().text() ||
        $(element).find("content\\:encoded").first().text(),
    );

    if (!isRelevantCandidate(title, description, source.slug)) {
      const reason = isInfrastructureCandidate(title)
        ? "infrastructure"
        : isPromotionalCandidate(title)
          ? "promotional"
          : "relevance";

      console.log(
        `RSS candidate excluded by ${reason} rule: ${title}`,
      );
      return;
    }

    seen.add(url);

    candidates.push({
      sourceSlug: source.slug,
      title,
      url,
      publishedAt,
      description,
    });
  });

  console.log(`RSS entries found: ${candidates.length}`);

  return candidates;
}

const TOPIC_DEFINITIONS = [
  {
    slug: "ai-tech",
    name: "AI и технологии",
    description:
      "Новые модели, AI-агенты, продукты, инструменты, робототехника и практическое применение ИИ.",
    sortOrder: 1,
    patterns: [
      /\bai[- ]agent(s)?\b/,
      /\bagentic\b/,
      /\bautonomous agent(s)?\b/,
      /\bllm(s)?\b/,
      /\blarge language model(s)?\b/,
      /\bfoundation model(s)?\b/,
      /\bmultimodal\b/,
      /\bnew model(s)?\b/,
      /\bmodel(s)?\s+(?:release|launch|update|training)\b/,
      /\bchatbot(s)?\b/,
      /\brobot(s|ics)?\b/,
      /\bhumanoid(s)?\b/,
      /\bcomputer vision\b/,
      /\bgenerative ai\b/,
      /\bgenai\b/,
      /\bsynthetic (?:media|content|data)\b/,
      /\bгенеративн/,
      /\bискусственн.*интеллект/,
      /\bнейросет/,
      /\bмультимодальн/,
      /\bробот(ы|а|ов|ам|ами|ах)?\b/,
      /\bавтономн.*(агент|систем|робот|ии)/,
      /\bclaude\b/,
      /\bgemini\b/,
      /\bgpt(?:-\d+(?:\.\d+)?)?\b/,
      /\bopenai\b/,
      /\banthropic\b/,
      /\bdeepmind\b/,
      /\bmistral\b/,
      /\bhugging face\b/,
    ],
  },
  {
    slug: "products-tools",
    name: "Продукты и инструменты",
    description:
      "AI-сервисы и инструменты, новые функции, режимы, интеграции и практические возможности.",
    sortOrder: 2,
    patterns: [
      /\bai (?:tool|tools|service|services|app|apps|assistant|assistants)\b/,
      /\bai[- ]powered (?:tool|tools|service|app|apps|assistant|software)\b/,
      /\b(?:tool|service|app|assistant|software|platform)\b.*\b(?:feature|features|mode|modes|capabilit(?:y|ies)|update|updates)\b/,
      /\b(?:feature|features|mode|modes|capabilit(?:y|ies)|update|updates)\b.*\b(?:tool|service|app|assistant|software|platform)\b/,
      /\bplugin(s)?\b/,
      /\bextension(s)?\b/,
      /\bcopilot\b/,
      /\bworkspace\b/,
      /\bgenerator(s)?\b/,
      /\beditor\b.*\bai\b/,
      /\bфункци[яи]\b.*\b(?:сервис|инструмент|продукт|приложен)/,
      /\b(?:сервис|инструмент|продукт|приложен)\w*\b.*\bфункци[яи]\b/,
      /\bвозможност[ьи]\b.*\b(?:сервис|инструмент|продукт|приложен)/,
      /\bновый режим\b/,
      /\bрежим\b.*\b(?:сервис|инструмент|продукт|приложен)/,
      /\bплагин/,
      /\bрасширени[ея]/,
      /\bассистент\w*\b.*\b(?:функци|возможност|режим)/,
    ],
  },
  {
    slug: "business-innovation",
    name: "Бизнес и инновации",
    description:
      "Компании, стартапы, инвестиции, сделки, рынок, продукты как бизнес и внедрение ИИ.",
    sortOrder: 3,
    patterns: [
      /\bstartup(s)?\b/,
      /\bfounder(s)?\b/,
      /\braises?\b/,
      /\braised\b/,
      /\bfunding\b/,
      /\binvestment(s)?\b/,
      /\binvestor(s)?\b/,
      /\bventure capital\b/,
      /\bvaluation\b/,
      /\bacqui(red|sition)\b/,
      /\bmerger\b/,
      /\bpartnership\b/,
      /\bdeal(s)?\b/,
      /\brevenue\b/,
      /\bmarket\b/,
      /\bcustomer(s)?\b/,
      /\benterprise\b/,
      /\bbusiness\b/,
      /\bcompany\b/,
      /\bcompanies\b/,
      /\bcommercial\b/,
      /\bcorporate\b/,
      /\bпродаж/,
      /\bвыручк/,
      /\bстартап/,
      /\bинвестици/,
      /\bфинансирован/,
      /\bкомпани/,
      /\bбизнес/,
      /\bрынок/,
      /\bпартнерств/,
      /\bсделк/,
    ],
  },
  {
    slug: "research",
    name: "Исследования",
    description:
      "Научные исследования, эксперименты, новые методы, оценки моделей и научные результаты.",
    sortOrder: 4,
    patterns: [
      /\bresearcher(s)?\b/,
      /\bresearch\b/,
      /\bstudy\b/,
      /\bstudies\b/,
      /\bpaper\b/,
      /\bscientific\b/,
      /\bexperiment(s)?\b/,
      /\bfindings?\b/,
      /\bmethod(s|ology)?\b/,
      /\bbenchmark(s)?\b/,
      /\bevaluation\b/,
      /\bdataset(s)?\b/,
      /\barxiv\b/,
      /\bpeer[- ]reviewed\b/,
      /\bscientist(s)?\b/,
      /\bmathematician(s)?\b/,
      /\bconjecture\b/,
      /\bисследован/,
      /\bуч[её]н/,
      /\bнаучн/,
      /\bэксперимент/,
      /\bметод/,
      /\bвыборк/,
      /\bрезультат.*исслед/,
      /\bтестирован/,
      /\bбенчмарк/,
    ],
  },
  {
    slug: "other",
    name: "Другое",
    description:
      "Релевантные материалы об ИИ и технологиях, которые не относятся однозначно к основным рубрикам.",
    sortOrder: 5,
    patterns: [
      /\belection(s)?\b/,
      /\bsenate\b/,
      /\bcongress\b/,
      /\bpolitic(s|al)?\b/,
      /\bcampaign\b/,
      /\bgovernment\b/,
      /\bregulation\b/,
      /\bregulat(ory|ion)\b/,
      /\blaw(s)?\b/,
      /\blegislation\b/,
      /\bpolicy\b/,
      /\brules?\b/,
      /\bcopyright\b/,
      /\bcourt\b/,
      /\bantitrust\b/,
      /\bsafety\b/,
      /\bexistential risk\b/,
      /\bsociet(y|al)\b/,
      /\bculture\b/,
      /\bjobs?\b/,
      /\blabor\b/,
      /\bworkforce\b/,
      /\bвыбор/,
      /\bсенат/,
      /\bконгресс/,
      /\bполит/,
      /\bправительств/,
      /\bрегулирован/,
      /\bзакон/,
      /\bзаконодательств/,
      /\bправил/,
      /\bавторск/,
      /\bсуд/,
      /\bантимонополь/,
      /\bбезопасност/,
      /\bобществен/,
      /\bкультур/,
      /\bработ/,
      /\bзанятост/,
    ],
  },
] as const;

type TopicDefinition = (typeof TOPIC_DEFINITIONS)[number];

function countTopicMatches(text: string, patterns: readonly RegExp[]): number {
  let matches = 0;

  for (const pattern of patterns) {
    if (pattern.test(text)) {
      matches++;
    }
  }

  return matches;
}

function classifyArticleTopic(
  title: string,
  content: string,
  sourceSlug: string,
): { topic: TopicDefinition; confidence: number } {
  const normalizedTitle = normalizeForMatch(title);
  const normalizedContent = normalizeForMatch(content);
  const normalizedText = `${normalizedTitle} ${normalizedContent.slice(0, 8000)}`;

  const count = (patterns: readonly RegExp[], value: string) =>
    patterns.reduce(
      (total, pattern) => total + (pattern.test(value) ? 1 : 0),
      0,
    );

  /*
   * Editorial classification priority:
   * 1. Explicit model-misalignment incidents -> Other.
   * 2. Product/tool/service stories -> Products & tools.
   * 3. Concrete commercial/company stories -> Business & innovation.
   * 4. Research/scientific results -> Research.
   * 5. Regulation, law, society, military, safety and public debate -> Other.
   * 6. AI models, agents and applications -> AI & technology.
   */

  const researchTitlePatterns = [
    /\bresearchers?\b/, /\bresearch\b/, /\bstud(y|ies)\b/,
    /\bpaper\b/, /\bscientists?\b/, /\bmathematicians?\b/,
    /\bexperiment(s)?\b/, /\bfindings?\b/, /\bbenchmark(s)?\b/,
    /\bevaluation\b/, /\bconjecture\b/, /\barxiv\b/,
    /\bpeer[- ]reviewed\b/, /\bscientific\b/, /\bnew method(s)?\b/,
    /\bmethodology\b/, /\bматематик/, /\bисследован/, /\bуч[её]н/,
    /\bнаучн/, /\bэксперимент/, /\bбенчмарк/, /\bтестирован/,
    /\bгипотез/, /\bтеорем/,
  ];

  const productTitlePatterns = [
    /\bai (?:tool|tools|service|services|app|apps|assistant|assistants)\b/,
    /\bai[- ]powered (?:tool|tools|service|app|apps|assistant|software)\b/,
    /\bplugin(s)?\b/,
    /\bextension(s)?\b/,
    /\bcopilot\b/,
    /\bworkspace\b/,
    /\bgenerator(s)?\b/,
    /\bfeature(s)?\b.*\b(?:ai|claude|gemini|gpt|openai|anthropic)\b/,
    /\b(?:ai|claude|gemini|gpt|openai|anthropic)\b.*\bfeature(s)?\b/,
    /\bnew mode\b/,
    /\bmode\b.*\b(?:ai|claude|gemini|gpt|openai|anthropic)\b/,
    /\b(?:tool|service|app|assistant|software|platform)\b.*\b(?:capabilit(?:y|ies)|feature|mode|update)\b/,
    /\b(?:capabilit(?:y|ies)|feature|mode|update)\b.*\b(?:tool|service|app|assistant|software|platform)\b/,
    /\bфункци[яи]\b.*\b(?:сервис|инструмент|продукт|приложен)/,
    /\b(?:сервис|инструмент|продукт|приложен)\w*\b.*\bфункци[яи]\b/,
    /\bвозможност[ьи]\b.*\b(?:сервис|инструмент|продукт|приложен)/,
    /\bновый режим\b/,
    /\bрежим\b.*\b(?:сервис|инструмент|продукт|приложен)/,
    /\bплагин/,
    /\bрасширени[ея]/,
  ];

  const businessTitlePatterns = [
    /\bstartup(s)?\b/, /\bfounder(s)?\b/, /\braises?\b/, /\braised\b/,
    /\bfunding\b/, /\binvestment(s)?\b/, /\binvestor(s)?\b/,
    /\bventure capital\b/, /\bvaluation\b/, /\bacqui(red|sition)\b/,
    /\bmerger\b/, /\bpartnership\b/, /\bpartner(?:s|ed|ing)?\b/,
    /\bdeal(s)?\b/, /\brevenue\b/, /\bfinancial consumer\b/,
    /\blegal market\b/, /\bcommercial market\b/,
    /\bmonetiz/, /\bpricing\b/, /\bcost-cutting\b/,
    /\bai\s*&\s*economy\b/,
    /\bjoin(?:s|ed|ing)?\b.*\b(?:team|company|firm|organization)\b/,
    /\b(?:team|company|firm|organization)\b.*\bjoin(?:s|ed|ing)?\b/,
    /\blaunch(?:es|ed|ing)?\b.*\b(?:product|service|platform)\b.*\b(?:market|customer|business|enterprise|commercial)\b/,
    /\b(?:product|service|platform)\b.*\blaunch(?:es|ed|ing)?\b.*\b(?:market|customer|business|enterprise|commercial)\b/,
    /\bnew .*product\b.*\b(?:market|customer|business|enterprise|commercial)\b/,
    /\bnew .*service\b.*\b(?:market|customer|business|enterprise|commercial)\b/,
    /\bпродаж/, /\bвыручк/, /\bстартап/, /\bинвестици/,
    /\bфинансирован/, /\bпартнерств/, /\bсделк/, /\bрынок/,
    /\bкоммерчес/,
  ];

  const otherTitlePatterns = [
    /\bai safety\b/, /\bsafety debate\b/,
    /\bai superintelligence slowdown\b/, /\bai slowdown\b/,
    /\bmisalign(?:ed|ment)\b/, /\brogue ai\b/,
    /\bharmful prompts?\b/, /\badversarial\b/, /\bwatermark(?:ing)?\b/,
    /\bregulat(?:e|es|ed|ion|ing)\b/, /\bgovernment(?:s)?\b/,
    /\bpolicy\b/, /\blaw\b/, /\blegal\b/, /\bcourt\b/, /\bantitrust\b/,
    /\bnuclear\b/, /\bbioweapon(?:s)?\b/, /\bmilitary\b/,
    /\bbattlefield\b/, /\bdrone(?:s)?\b/, /\bjobs?\b/, /\blabor\b/,
    /\bworkforce\b/, /\bcopyright\b/, /\bfair use\b/,
    /\bsociet(?:y|al)\b/, /\bexistential risk\b/, /\bai doom\b/,
    /\bapocalypse\b/, /\bsenate\b/, /\belection\b/,
    /\bpolitic(?:s|al)\b/, /\bking of england\b/,
    /\bpublic (?:opinion|debate|reaction)\b/,
    /\bair traffic\b/, /\bfaa\b/,
    /\bagi debate\b/, /\bwiden the agi debate\b/,
    /\bchains? of thought\b/, /\btransparency\b/,
    /\bclone teachers?\b/, /\bdigitally clone teachers?\b/,
    /\bai threats?\b/, /\bthreats? are real\b/,
    /\bai industry\b.*\bresearch\b.*\bpaused?\b/,
    /\bfollowed its own research\b/,
  ];

  const explicitMisalignmentPatterns = [
    /\bmodels?\b.*\b(?:hide|hiding|conceal|concealing)\b.*\b(?:behavior|behaviour)\b/,
    /\b(?:hide|hiding|conceal|concealing)\b.*\b(?:bad behavior|bad behaviour)\b/,
    /\b(?:leaving|left)\b.*\bnotes?\b.*\bsuccessor/,
    /\bprompt injection\b/, /\bjailbreak(?:ed|ing|s)?\b/,
    /\bmisalign(?:ed|ment)\b/, /\brogue ai\b/,
    /\btried to jailbreak\b/, /\bjailbreak itself\b/,
  ];

  const productMatches = count(productTitlePatterns, normalizedText);
  const researchMatches = count(researchTitlePatterns, normalizedTitle);
  const businessMatches = count(businessTitlePatterns, normalizedTitle);
  const otherMatches = count(otherTitlePatterns, normalizedTitle);
  const misalignmentMatches = count(
    explicitMisalignmentPatterns,
    normalizedTitle,
  );

  // Explicit model-behavior incidents are Other.
  if (misalignmentMatches > 0) {
    return {
      topic: TOPIC_DEFINITIONS[4],
      confidence: 0.95,
    };
  }

  // Product/tool stories get their own topic when the headline/body clearly
  // describes an AI service, tool, feature, mode, integration or capability.
  // Explicitly commercial stories remain Business & innovation.
  if (productMatches > 0 && businessMatches === 0) {
    return {
      topic: TOPIC_DEFINITIONS[1],
      confidence: productMatches >= 2 ? 0.95 : 0.9,
    };
  }

  // Concrete commercial/product stories take priority over generic legal or
  // safety wording, but only when the headline clearly describes a business
  // action, launch, market move or company activity.
  if (businessMatches > 0) {
    return {
      topic: TOPIC_DEFINITIONS[2],
      confidence: businessMatches >= 2 ? 0.95 : 0.9,
    };
  }

  // Research-led material remains Research even when the title also mentions
  // existential risk or another consequence.
  if (researchMatches > 0) {
    return {
      topic: TOPIC_DEFINITIONS[3],
      confidence: researchMatches >= 2 ? 0.95 : 0.9,
    };
  }

  if (otherMatches > 0) {
    return {
      topic: TOPIC_DEFINITIONS[4],
      confidence: otherMatches >= 2 ? 0.95 : 0.9,
    };
  }

  const businessBodyPatterns = [
    /\bpartnership\b/, /\bcommercial\b/, /\benterprise\b/,
    /\bcustomer(?:s)?\b/, /\bpricing\b/, /\brevenue\b/,
    /\bfundrais(?:e|es|ed|ing)\b/, /\binvest(?:s|ed|ment|ing)?\b/,
    /\bacqui(?:re|res|red|sition)\b/,
  ];

  if (count(businessBodyPatterns, normalizedText) >= 2) {
    return {
      topic: TOPIC_DEFINITIONS[2],
      confidence: 0.8,
    };
  }

  if (isAiFocusedSource(sourceSlug)) {
    return {
      topic: TOPIC_DEFINITIONS[0],
      confidence: 0.7,
    };
  }

  return {
    topic: TOPIC_DEFINITIONS[4],
    confidence: 0.7,
  };
}

async function ensureTopics(): Promise<void> {
  for (const definition of TOPIC_DEFINITIONS) {
    await prisma.topic.upsert({
      where: {
        slug: definition.slug,
      },
      update: {
        name: definition.name,
        description: definition.description,
        isActive: true,
        sortOrder: definition.sortOrder,
      },
      create: {
        name: definition.name,
        slug: definition.slug,
        description: definition.description,
        isActive: true,
        sortOrder: definition.sortOrder,
      },
    });
  }
}

async function assignPrimaryTopic(
  articleId: string,
  title: string,
  content: string,
  sourceSlug: string,
): Promise<void> {
  const classification = classifyArticleTopic(title, content, sourceSlug);

  const topic = await prisma.topic.findUnique({
    where: {
      slug: classification.topic.slug,
    },
  });

  if (!topic) {
    throw new Error(
      `Topic not found after initialization: ${classification.topic.slug}`,
    );
  }

  const currentPrimary = await prisma.articleTopic.findFirst({
    where: {
      articleId,
      isPrimary: true,
    },
    include: {
      topic: true,
    },
  });

  if (currentPrimary?.topic.slug === topic.slug) {
    await prisma.articleTopic.update({
      where: {
        articleId_topicId: {
          articleId,
          topicId: topic.id,
        },
      },
      data: {
        confidence: classification.confidence,
        isPrimary: true,
      },
    });
  } else {
    await prisma.articleTopic.deleteMany({
      where: {
        articleId,
      },
    });

    await prisma.articleTopic.create({
      data: {
        articleId,
        topicId: topic.id,
        confidence: classification.confidence,
        isPrimary: true,
      },
    });
  }

  console.log(
    `Topic assigned: ${classification.topic.name} (${classification.confidence})`,
  );
}


async function reclassifyDigestArticles(
  digestId: string,
): Promise<void> {
  const digestArticles = await prisma.digestArticle.findMany({
    where: {
      digestId,
    },
    include: {
      article: {
        include: {
          articleSources: {
            include: {
              source: true,
            },
            take: 1,
          },
        },
      },
    },
  });

  for (const item of digestArticles) {
    const sourceSlug =
      item.article.articleSources[0]?.source.slug;

    if (!sourceSlug) {
      continue;
    }

    await assignPrimaryTopic(
      item.article.id,
      item.article.title,
      item.article.originalContent?.slice(0, 12000) ?? "",
      sourceSlug,
    );
  }
}

async function getTodayDigest() {
  const issueDate = getMoscowDate();
  const date = getDateOnly(issueDate);

  const existingDigest = await prisma.digest.findUnique({
    where: {
      periodStart: date,
    },
  });

  if (existingDigest) {
    return existingDigest;
  }

  return prisma.digest.create({
    data: {
      title: `Выпуск от ${issueDate}`,
      periodStart: date,
      periodEnd: date,
      status: "PUBLISHED",
    },
  });
}

async function getNextDigestPosition(
  digestId: string,
): Promise<number> {
  const lastArticle =
    await prisma.digestArticle.findFirst({
      where: { digestId },
      orderBy: { position: "desc" },
    });

  return (lastArticle?.position ?? 0) + 1;
}

async function addArticleToDigest(
  digestId: string,
  articleId: string,
): Promise<boolean> {
  const existing =
    await prisma.digestArticle.findUnique({
      where: {
        digestId_articleId: {
          digestId,
          articleId,
        },
      },
    });

  if (existing) {
    console.log(
      `Article already belongs to today's digest: ${articleId}`,
    );
    return false;
  }

  const position =
    await getNextDigestPosition(digestId);

  await prisma.digestArticle.create({
    data: {
      digestId,
      articleId,
      position,
    },
  });

  console.log(
    `Article added to today's digest: position ${position}`,
  );

  return true;
}

async function getOrCreateSource(
  sourceConfig: SourceConfig,
) {
  const source = await prisma.source.upsert({
    where: {
      slug: sourceConfig.slug,
    },
    update: {
      name: sourceConfig.name,
      url: sourceConfig.url,
      language: sourceConfig.language,
      country:
        sourceConfig.language === "ru" ? "RU" : null,
      sourceType: sourceConfig.sourceType,
      isActive: true,
    },
    create: {
      slug: sourceConfig.slug,
      name: sourceConfig.name,
      url: sourceConfig.url,
      language: sourceConfig.language,
      country:
        sourceConfig.language === "ru" ? "RU" : null,
      sourceType: sourceConfig.sourceType,
      isActive: true,
    },
  });

  const sourceFeed = await prisma.sourceFeed.upsert({
    where: {
      sourceId_url: {
        sourceId: source.id,
        url: sourceConfig.url,
      },
    },
    update: {
      feedType: sourceConfig.feedType,
      isActive: true,
    },
    create: {
      sourceId: source.id,
      feedType: sourceConfig.feedType,
      url: sourceConfig.url,
      isActive: true,
    },
  });

  return {
    source,
    sourceFeed,
  };
}

async function saveAcceptedArticleSource(
  articleId: string,
  sourceId: string,
  sourceFeedId: string,
  sourceUrl: string,
): Promise<void> {
  const existing =
    await prisma.articleSource.findFirst({
      where: {
        articleId,
        sourceId,
        sourceUrl,
      },
    });

  if (existing) {
    return;
  }

  await prisma.articleSource.create({
    data: {
      articleId,
      sourceId,
      sourceFeedId,
      sourceUrl,
    },
  });
}

async function translateAcceptedArticle(
  articleId: string,
  title: string,
  originalContent: string,
) {
  console.log("");
  console.log("--- DEEPL TRANSLATION ---");

  const translation = await translateArticle(
    title,
    originalContent,
  );

  const updatedArticle = await prisma.article.update({
    where: { id: articleId },
    data: {
      translatedTitle: translation.translatedTitle,
      translatedContent: translation.translatedContent,
      translationLanguage:
        translation.translationLanguage,
      translationProvider:
        translation.translationProvider,
      translatedAt: translation.translatedAt,
    },
  });

  console.log(
    `Russian title saved: ${translation.translatedTitle.length} characters`,
  );
  console.log(
    `Russian content saved: ${translation.translatedContent.length} characters`,
  );

  return updatedArticle;
}

async function createCollectionItem(
  runId: string,
  sourceFeedId: string,
  articleId: string | null,
  status: string,
  error?: string,
) {
  return prisma.collectionItem.create({
    data: {
      collectionRunId: runId,
      sourceFeedId,
      articleId,
      status,
      error,
    },
  });
}

async function processCandidate(params: {
  candidate: Candidate;
  sourceConfig: SourceConfig;
  source: Awaited<
    ReturnType<typeof getOrCreateSource>
  >["source"];
  sourceFeed: Awaited<
    ReturnType<typeof getOrCreateSource>
  >["sourceFeed"];
  digest: Awaited<ReturnType<typeof getTodayDigest>>;
  runId: string;
  cutoff: Date;
}) {
  const {
    candidate,
    sourceConfig,
    source,
    sourceFeed,
    digest,
    runId,
    cutoff,
  } = params;

  console.log("");
  console.log("--- CANDIDATE ---");
  console.log(`Source: ${source.name}`);
  console.log(`Title: ${candidate.title}`);
  console.log(`URL: ${candidate.url}`);
  console.log(
    `RSS published: ${candidate.publishedAt ?? "not found"}`,
  );

  if (!isFresh(candidate.publishedAt, cutoff)) {
    console.log(
      "Article skipped: RSS publication date is missing or older than 24 hours.",
    );

    await createCollectionItem(
      runId,
      sourceFeed.id,
      null,
      "NOT_RELEVANT",
      "Article is outside the 24-hour collection window or has no RSS publication date.",
    );

    return {
      fresh: false,
      newArticle: false,
      duplicate: false,
      relevant: false,
      error: false,
    };
  }

  let details: ExtractedArticle;

  try {
    details = await extractArticle(candidate.url);
  } catch (error) {
    console.error(
      `Article extraction failed: ${candidate.url}`,
    );
    console.error(error);

    await createCollectionItem(
      runId,
      sourceFeed.id,
      null,
      "ERROR",
      error instanceof Error
        ? error.message
        : String(error),
    );

    return {
      fresh: false,
      newArticle: false,
      duplicate: false,
      relevant: false,
      error: true,
    };
  }

  console.log(
    `Extracted article text: ${details.text.length} characters`,
  );
  console.log(
    `Published in article: ${details.publishedAt ?? "not found"}`,
  );

  const canonicalUrl = normalizeUrl(
    candidate.url,
    sourceConfig.url,
  );

  const existingArticle =
    await prisma.article.findUnique({
      where: { canonicalUrl },
    });

  if (existingArticle) {
    console.log(
      `Existing article: ${existingArticle.id}`,
    );

    if (
      !isRelevantCandidate(
        existingArticle.title,
        existingArticle.originalContent.slice(0, 12000),
        sourceConfig.slug,
      )
    ) {
      console.log(
        "Existing article skipped: current editorial relevance rules do not accept it.",
      );

      await createCollectionItem(
        runId,
        sourceFeed.id,
        existingArticle.id,
        "NOT_RELEVANT",
        "Existing article failed the current deterministic editorial relevance filter.",
      );

      return {
        fresh: true,
        newArticle: false,
        duplicate: true,
        relevant: false,
        error: false,
      };
    }

    if (
      !existingArticle.imageUrl &&
      (details.imageUrl || candidate.imageUrl)
    ) {
      await prisma.article.update({
        where: {
          id: existingArticle.id,
        },
        data: {
          imageUrl:
            details.imageUrl ?? candidate.imageUrl,
        },
      });

      console.log(
        "Preview image saved for existing article.",
      );
    }

    await saveAcceptedArticleSource(
      existingArticle.id,
      source.id,
      sourceFeed.id,
      candidate.url,
    );

    await assignPrimaryTopic(
      existingArticle.id,
      existingArticle.title,
      existingArticle.originalContent.slice(0, 12000),
      source.slug,
    );

    const added = await addArticleToDigest(
      digest.id,
      existingArticle.id,
    );

    await createCollectionItem(
      runId,
      sourceFeed.id,
      existingArticle.id,
      "RELEVANT",
    );

    return {
      fresh: true,
      newArticle: false,
      duplicate: true,
      relevant: added,
      error: false,
    };
  }

  const contentHash = crypto
    .createHash("sha256")
    .update(canonicalUrl)
    .digest("hex");

  const contentType =
    await prisma.contentType.findUnique({
      where: { code: "NEWS" },
    });

  if (!contentType) {
    throw new Error(
      "Content type NEWS not found.",
    );
  }

  const articleRecord = await prisma.article.create({
    data: {
      title: details.title || candidate.title,
      originalTitle:
        details.title || candidate.title,
      url: candidate.url,
      canonicalUrl,
      author: details.author,
      publishedAt: details.publishedAt
        ? new Date(details.publishedAt)
        : candidate.publishedAt
          ? new Date(candidate.publishedAt)
          : null,
      language: sourceConfig.language,
      excerpt: null,
      imageUrl: details.imageUrl ?? candidate.imageUrl,
      contentHash,
      originalContent: details.text,
      status: "NEW",
      contentTypeId: contentType.id,
    },
  });

  console.log(
    `Article created: ${articleRecord.id}`,
  );

  await saveAcceptedArticleSource(
    articleRecord.id,
    source.id,
    sourceFeed.id,
    candidate.url,
  );

  let publishedArticle = articleRecord;

  if (sourceConfig.language !== "ru") {
    try {
      publishedArticle =
        await translateAcceptedArticle(
          articleRecord.id,
          articleRecord.title,
          articleRecord.originalContent,
        );
    } catch (error) {
      console.error(
        `DeepL translation failed for article: ${articleRecord.id}`,
      );
      console.error(error);

      // Keep the original article when translation is unavailable
      // (for example, when the DeepL character quota is exhausted).
      // The web page falls back to the original title and content.
      publishedArticle = articleRecord;

      console.log(
        "Original article will be published because DeepL translation is unavailable.",
      );
    }
  } else {
    publishedArticle =
      await prisma.article.update({
        where: { id: articleRecord.id },
        data: {
          translatedTitle: articleRecord.title,
          translatedContent:
            articleRecord.originalContent,
          translationLanguage: "ru",
          translationProvider: null,
          translatedAt: null,
        },
      });

    console.log(
      "Russian source detected: DeepL translation skipped.",
    );
  }

  await assignPrimaryTopic(
    publishedArticle.id,
    publishedArticle.title,
    publishedArticle.originalContent.slice(0, 12000),
    source.slug,
  );

  publishedArticle =
    await prisma.article.update({
      where: { id: publishedArticle.id },
      data: { status: "PUBLISHED" },
    });

  const added = await addArticleToDigest(
    digest.id,
    publishedArticle.id,
  );

  await createCollectionItem(
    runId,
    sourceFeed.id,
    publishedArticle.id,
    "RELEVANT",
  );

  console.log(
    `Article accepted: ${publishedArticle.id}`,
  );

  return {
    fresh: true,
    newArticle: true,
    duplicate: false,
    relevant: added,
    error: false,
  };
}

async function main() {
  console.log("Starting RSS collection run...");

  const run = await prisma.collectionRun.create({
    data: {
      status: "RUNNING",
      sourcesChecked: 0,
      articlesFound: 0,
      articlesNew: 0,
      articlesDuplicate: 0,
      articlesRelevant: 0,
      errorCount: 0,
    },
  });

  console.log(`Collection run: ${run.id}`);

  let sourcesChecked = 0;
  let articlesFound = 0;
  let articlesNew = 0;
  let articlesDuplicate = 0;
  let articlesRelevant = 0;
  let errorCount = 0;

  try {
    await ensureTopics();

    const digest = await getTodayDigest();

    console.log("");
    console.log("--- TODAY'S DIGEST ---");
    console.log(`Digest ID: ${digest.id}`);
    console.log(`Digest title: ${digest.title}`);

    const cutoff = new Date(
      Date.now() -
        LOOKBACK_HOURS * 60 * 60 * 1000,
    );

    console.log("");
    console.log(
      `Looking for RSS articles published since: ${cutoff.toISOString()}`,
    );

    for (const sourceConfig of SOURCES) {
      try {
        const { source, sourceFeed } =
          await getOrCreateSource(sourceConfig);

        sourcesChecked++;

        const candidates =
          await collectSource(sourceConfig);

        for (const candidate of candidates) {
          const result = await processCandidate({
            candidate,
            sourceConfig,
            source,
            sourceFeed,
            digest,
            runId: run.id,
            cutoff,
          });

          if (result.fresh) {
            articlesFound++;
          }

          if (result.newArticle) {
            articlesNew++;
          }

          if (result.duplicate) {
            articlesDuplicate++;
          }

          if (result.relevant) {
            articlesRelevant++;
          }

          if (result.error) {
            errorCount++;
          }
        }

        await prisma.sourceFeed.update({
          where: { id: sourceFeed.id },
          data: {
            lastCheckedAt: new Date(),
            lastSuccessAt: new Date(),
            lastError: null,
          },
        });
      } catch (error) {
        errorCount++;

        console.error(
          `Failed to process source: ${sourceConfig.name}`,
        );
        console.error(error);

        try {
          const { sourceFeed } =
            await getOrCreateSource(sourceConfig);

          await prisma.sourceFeed.update({
            where: { id: sourceFeed.id },
            data: {
              lastCheckedAt: new Date(),
              lastError:
                error instanceof Error
                  ? error.message
                  : String(error),
            },
          });
        } catch (sourceError) {
          console.error(
            "Failed to update source feed error state.",
          );
          console.error(sourceError);
        }
      }
    }

    await reclassifyDigestArticles(digest.id);

    await prisma.collectionRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: "SUCCESS",
        sourcesChecked,
        articlesFound,
        articlesNew,
        articlesDuplicate,
        articlesRelevant,
        errorCount,
      },
    });

    console.log("");
    console.log("==============================");
    console.log("RSS COLLECTION RUN COMPLETED");
    console.log("==============================");
    console.log(`Run ID: ${run.id}`);
    console.log(`Digest ID: ${digest.id}`);
    console.log(`Sources checked: ${sourcesChecked}`);
    console.log(`Fresh articles: ${articlesFound}`);
    console.log(`Articles new: ${articlesNew}`);
    console.log(`Articles duplicate: ${articlesDuplicate}`);
    console.log(
      `Articles accepted and added to digest: ${articlesRelevant}`,
    );
    console.log(`Errors: ${errorCount}`);
  } catch (error) {
    await prisma.collectionRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        status: "FAILED",
        sourcesChecked,
        articlesFound,
        articlesNew,
        articlesDuplicate,
        articlesRelevant,
        errorCount: errorCount + 1,
        errorLog:
          error instanceof Error
            ? error.message
            : String(error),
      },
    });

    throw error;
  }
}

main()
  .catch((error) => {
    console.error("");
    console.error("FAILED");
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
