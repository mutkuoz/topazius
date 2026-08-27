import { render } from 'preact';

function Placeholder() {
  return <p>Topazius</p>;
}

const root = document.getElementById('app');
if (!root) throw new Error('#app mount point is missing from index.html');
render(<Placeholder />, root);
