import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  Bot,
  Brain,
  ChartColumn,
  ClipboardList,
  Drama,
  FileText,
  FlaskConical,
  Globe,
  Landmark,
  Laptop,
  Lightbulb,
  MessagesSquare,
  Newspaper,
  Palette,
  PenLine,
  Puzzle,
  Rocket,
  Search,
  Settings,
  Shield,
  Sparkles,
  Target,
  TrendingUp,
  User,
  Wrench,
  Zap,
} from 'lucide-react';

/**
 * Ícones de agente vêm dos DADOS (presets BMAD, agentes criados pelo usuário)
 * como string emoji. Aqui os emojis conhecidos viram o ícone lucide
 * equivalente, com uma cor que lembra o emoji original; um emoji customizado
 * desconhecido é exibido como está.
 */
const EMOJI_ICONS: Record<string, [LucideIcon, string]> = {
  '🤖': [Bot, '#1d4fa0'],
  '📋': [ClipboardList, '#a87900'],
  '📊': [ChartColumn, '#1d4fa0'],
  '📉': [ChartColumn, '#c93a2c'],
  '📈': [TrendingUp, '#178246'],
  '🎨': [Palette, '#b03aa0'],
  '🧠': [Brain, '#c94f7c'],
  '🔎': [Search, '#1d4fa0'],
  '🔍': [Search, '#1d4fa0'],
  '🌐': [Globe, '#2563eb'],
  '🧪': [FlaskConical, '#178246'],
  '🛠': [Wrench, '#64748b'],
  '🛠️': [Wrench, '#64748b'],
  '🔧': [Wrench, '#64748b'],
  '📚': [BookOpen, '#b45309'],
  '✨': [Sparkles, '#dd9a00'],
  '🧩': [Puzzle, '#178246'],
  '✍️': [PenLine, '#4d5e80'],
  '📝': [PenLine, '#4d5e80'],
  '💡': [Lightbulb, '#dd9a00'],
  '🎯': [Target, '#c93a2c'],
  '🛡': [Shield, '#1d4fa0'],
  '🛡️': [Shield, '#1d4fa0'],
  '🚀': [Rocket, '#c93a2c'],
  '💬': [MessagesSquare, '#2563eb'],
  '🏛': [Landmark, '#7e6a45'],
  '🏛️': [Landmark, '#7e6a45'],
  '💻': [Laptop, '#4d5e80'],
  '👤': [User, '#7e8ba3'],
  '🎭': [Drama, '#7c3aed'],
  '⚡': [Zap, '#dd9a00'],
  '⚙': [Settings, '#64748b'],
  '⚙️': [Settings, '#64748b'],
  '📄': [FileText, '#4d5e80'],
  '📰': [Newspaper, '#4d5e80'],
};

export function AgentIcon(props: { icon?: string; className?: string }) {
  const key = props.icon?.trim();
  const entry = key ? EMOJI_ICONS[key] : EMOJI_ICONS['🤖'];
  if (entry) {
    const [Icon, color] = entry;
    return <Icon className={props.className ?? 'icon'} style={{ color }} aria-hidden />;
  }
  // emoji customizado que não conhecemos: respeita a escolha do usuário
  return <span aria-hidden>{key}</span>;
}
