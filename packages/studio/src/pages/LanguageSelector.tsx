import { useState } from "react";

export function LanguageSelector({ onSelect }: { onSelect: (lang: "zh" | "ko" | "en") => void }) {
  const [hovering, setHovering] = useState<"zh" | "ko" | "en" | null>(null);
  const [selected, setSelected] = useState<"zh" | "ko" | "en" | null>(null);

  const handleSelect = (lang: "zh" | "ko" | "en") => {
    setSelected(lang);
    // Brief pause for the selection animation before transitioning
    setTimeout(() => onSelect(lang), 400);
  };

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center px-8">
      {/* Logo — cinematic scale */}
      <div className="mb-16 text-center">
        <div className="flex items-baseline justify-center gap-1.5 mb-4">
          <span className="font-serif text-6xl italic text-primary">Ink</span>
          <span className="text-5xl font-semibold tracking-tight text-foreground">OS</span>
        </div>
        <div className="text-base text-muted-foreground tracking-widest uppercase">Studio</div>
      </div>

      {/* Language cards — generous, distinct, immersive */}
      <div className="flex gap-8 mb-16">
        <button
          onClick={() => handleSelect("ko")}
          onMouseEnter={() => setHovering("ko")}
          onMouseLeave={() => setHovering(null)}
          className={`group w-80 border rounded-lg p-10 text-left transition-all duration-300 ${
            selected === "ko"
              ? "border-primary bg-primary/10 scale-[1.02]"
              : hovering === "ko"
                ? "border-primary/50 bg-card"
                : "border-border bg-card/50"
          }`}
        >
          <div className="font-serif text-3xl mb-4 text-foreground">한국어 창작</div>
          <div className="text-base text-foreground/70 leading-relaxed mb-6">
            현대물 · 판타지 · 로맨스 · 미스터리 · 장르소설
          </div>
          <div className="text-sm text-muted-foreground">
            한국 웹소설 집필 · 회차당 글자 수 기준
          </div>
        </button>

        <button
          onClick={() => handleSelect("zh")}
          onMouseEnter={() => setHovering("zh")}
          onMouseLeave={() => setHovering(null)}
          className={`group w-80 border rounded-lg p-10 text-left transition-all duration-300 ${
            selected === "zh"
              ? "border-primary bg-primary/10 scale-[1.02]"
              : hovering === "zh"
                ? "border-primary/50 bg-card"
                : "border-border bg-card/50"
          }`}
        >
          <div className="font-serif text-3xl mb-4 text-foreground">中文创作</div>
          <div className="text-base text-foreground/70 leading-relaxed mb-6">
            玄幻 · 仙侠 · 都市 · 恐怖 · 通用
          </div>
          <div className="text-sm text-muted-foreground">
            番茄小说 · 起点中文网 · 飞卢
          </div>
        </button>

        <button
          onClick={() => handleSelect("en")}
          onMouseEnter={() => setHovering("en")}
          onMouseLeave={() => setHovering(null)}
          className={`group w-80 border rounded-lg p-10 text-left transition-all duration-300 ${
            selected === "en"
              ? "border-primary bg-primary/10 scale-[1.02]"
              : hovering === "en"
                ? "border-primary/50 bg-card"
                : "border-border bg-card/50"
          }`}
        >
          <div className="font-serif text-3xl italic mb-4 text-foreground">English Writing</div>
          <div className="text-base text-foreground/70 leading-relaxed mb-6">
            LitRPG · Progression · Romantasy · Sci-Fi · Isekai
          </div>
          <div className="text-sm text-muted-foreground">
            Royal Road · Kindle Unlimited · Scribble Hub
          </div>
        </button>
      </div>

      <div className="text-sm text-muted-foreground">
        설정에서 변경 가능 · 可在设置中更改 · Can be changed in Settings
      </div>
    </div>
  );
}
