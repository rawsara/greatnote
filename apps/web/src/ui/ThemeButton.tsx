import { cycleTheme, THEME_LABEL, useTheme } from './theme';
import { Icon } from './icons';

export function ThemeButton() {
  const t = useTheme();
  const I = t === 'dark' ? Icon.moon : t === 'light' ? Icon.sun : Icon.monitor;
  return (
    <button className="icon-btn" title={`${THEME_LABEL[t]} (눌러서 전환)`} aria-label={THEME_LABEL[t]} onClick={cycleTheme}>
      <I />
    </button>
  );
}
