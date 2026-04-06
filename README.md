# Amyloids Interface

React + TypeScript web app for exploring amyloid graph data with Cosmograph.

## Prerequisites

- Node.js 18+
- npm

## Run Locally

1. Install dependencies:

   npm install

2. Start the local dev server:

   npm run dev

3. Open the app:

   http://localhost:8000

The dev command bundles with esbuild, serves the project from the repository root, and writes build artifacts to dist.

## Production Build

Run:

npm run build

This creates the production bundle in dist.

## Available Scripts

- npm run dev: Start local server with sourcemaps.
- npm run build: Create production bundle in dist.

## Data Files

- data/nodes.csv
- data/edges.csv

## Stop Tracking node_modules and dist in Git

If node_modules or dist were committed before adding them to .gitignore, run:

git rm -r --cached node_modules dist
git add .gitignore README.md
git commit -m "Add README and stop tracking build/dependency folders"
git push

Notes:
- This removes those folders from Git tracking only.
- Your local files are not deleted.
