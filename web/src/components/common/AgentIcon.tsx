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
 * equivalente; um emoji customizado desconhecido é exibido como está.
 */
const EMOJI_ICONS: Record<string, LucideIcon> = {
  '🤖': Bot,
  '📋': ClipboardList,
  '📊': ChartColumn,
  '📉': ChartColumn,
  '📈': TrendingUp,
  '🎨': Palette,
  '🧠': Brain,
  '🔎': Search,
  '🔍': Search,
  '🌐': Globe,
  '🧪': FlaskConical,
  '🛠': Wrench,
  '🛠️': Wrench,
  '🔧': Wrench,
  '📚': BookOpen,
  '✨': Sparkles,
  '🧩': Puzzle,
  '✍️': PenLine,
  '📝': PenLine,
  '💡': Lightbulb,
  '🎯': Target,
  '🛡': Shield,
  '🛡️': Shield,
  '🚀': Rocket,
  '💬': MessagesSquare,
  '🏛': Landmark,
  '🏛️': Landmark,
  '💻': Laptop,
  '👤': User,
  '🎭': Drama,
  '⚡': Zap,
  '⚙': Settings,
  '⚙️': Settings,
  '📄': FileText,
  '📰': Newspaper,
};

export function AgentIcon(props: { icon?: string; className?: string }) {
  const key = props.icon?.trim();
  const Icon = key ? EMOJI_ICONS[key] : Bot;
  if (Icon) return <Icon className={props.className ?? 'icon'} aria-hidden />;
  // emoji customizado que não conhecemos: respeita a escolha do usuário
  return <span aria-hidden>{key}</span>;
}
