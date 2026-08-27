import { render } from 'preact';
import { App } from './app';
import { openVaultDB } from './lib/db';

const root = document.getElementById('app');
if (!root) throw new Error('#app mount point is missing from index.html');

void openVaultDB().then((db) => render(<App db={db} />, root));
