import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Repo } from './storage/repo';
import './styles.css';
import { applyTheme } from './ui/theme';

applyTheme();

Repo.open().then((repo) => {
  createRoot(document.getElementById('root')!).render(<App repo={repo} />);
});
