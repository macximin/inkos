import {
  Zap,
  Search,
  FileOutput,
  TrendingUp,
} from "lucide-react";
import { tr } from "../../lib/app-language";

export interface QuickActionsProps {
  readonly onAction: (command: string, requestedIntent?: "write_next") => void;
  readonly disabled: boolean;
}

interface ChipDef {
  readonly icon: React.ReactNode;
  readonly labelZh: string;
  readonly labelKo: string;
  readonly labelEn: string;
  readonly commandZh: string;
  readonly commandKo: string;
  readonly commandEn: string;
  readonly requestedIntent?: "write_next";
}

const CHIPS: ReadonlyArray<ChipDef> = [
  {
    icon: <Zap size={12} />,
    labelZh: "写下一章",
    labelKo: "다음 화 쓰기",
    labelEn: "Write next",
    commandZh: "写下一章",
    commandKo: "다음 화 쓰기",
    commandEn: "write next",
    requestedIntent: "write_next",
  },
  {
    icon: <Search size={12} />,
    labelZh: "审计",
    labelKo: "검수",
    labelEn: "Audit",
    commandZh: "审计",
    commandKo: "현재 작품을 검수해 줘",
    commandEn: "audit",
  },
  {
    icon: <FileOutput size={12} />,
    labelZh: "导出",
    labelKo: "내보내기",
    labelEn: "Export",
    commandZh: "导出全书",
    commandKo: "작품 전체 내보내기",
    commandEn: "export book",
  },
  {
    icon: <TrendingUp size={12} />,
    labelZh: "市场雷达",
    labelKo: "시장 레이더",
    labelEn: "Market radar",
    commandZh: "扫描市场趋势",
    commandKo: "시장 동향 스캔",
    commandEn: "scan market trends",
  },
];

export function QuickActions({ onAction, disabled }: QuickActionsProps) {
  return (
    <div className="flex gap-2 overflow-x-auto px-1 py-1">
      {CHIPS.map((chip) => {
        const label = tr(chip.labelZh, chip.labelEn, chip.labelKo);
        const command = tr(chip.commandZh, chip.commandEn, chip.commandKo);
        return (
          <button
            key={label}
            onClick={() => onAction(command, chip.requestedIntent)}
            disabled={disabled}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-secondary/50 border border-border/30 text-xs font-medium text-muted-foreground hover:text-primary hover:border-primary/30 hover:bg-primary/5 transition-all disabled:opacity-40 disabled:pointer-events-none group"
          >
            <span className="group-hover:scale-110 transition-transform">{chip.icon}</span>
            {label}
          </button>
        );
      })}
    </div>
  );
}
