import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { initBridge } from './lib/bridge';

const root = createRoot(document.getElementById('root')!);

initBridge().then((ok) => {
  if (ok) root.render(<App />);
  else root.render(<div className="empty-state">G Ultra only runs as a Windows or Android app.</div>);
});
