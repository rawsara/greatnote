import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Repo } from './storage/repo';
import './styles.css';

Repo.open().then((repo) => {
  createRoot(document.getElementById('root')!).render(<App repo={repo} />);
});
