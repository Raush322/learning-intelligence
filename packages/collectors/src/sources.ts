export type SourceConfig = {
  slug: string;
  name: string;
  url: string;
  feedType: "RSS";
  language: "ru" | "en";
  sourceType: "MEDIA" | "RESEARCH" | "ORGANIZATION";
};

export const SOURCES: SourceConfig[] = [
  {
    slug: "google-ai",
    name: "Google — AI",
    url: "https://blog.google/innovation-and-ai/technology/ai/rss/",
    feedType: "RSS",
    language: "en",
    sourceType: "ORGANIZATION",
  },
  {
    slug: "the-verge-ai",
    name: "The Verge — AI",
    url: "https://www.theverge.com/rss/ai-artificial-intelligence/index.xml",
    feedType: "RSS",
    language: "en",
    sourceType: "MEDIA",
  },
  {
    slug: "wired-ai",
    name: "WIRED — AI",
    url: "https://www.wired.com/feed/tag/ai/latest/rss",
    feedType: "RSS",
    language: "en",
    sourceType: "MEDIA",
  },
  {
    slug: "ars-technica-ai",
    name: "Ars Technica — AI",
    url: "https://arstechnica.com/ai/feed/",
    feedType: "RSS",
    language: "en",
    sourceType: "MEDIA",
  },
  {
    slug: "the-decoder",
    name: "The Decoder",
    url: "https://the-decoder.com/feed/",
    feedType: "RSS",
    language: "en",
    sourceType: "MEDIA",
  },
];