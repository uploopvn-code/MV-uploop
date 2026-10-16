// Routes: recipes — whole production runs the tool executes by itself (lib/recipes.mjs).
import { NEXT, body, json } from '../http.mjs';
import { db } from '../projects.mjs';
import { publicState } from '../public-state.mjs';
import {
  continueRecipe,
  deleteRecipe,
  listRecipes,
  saveRecipe,
  startRecipe,
  stopRecipe,
} from '../recipes.mjs';

export async function handle(req, res, p) {
  if (p === '/api/recipes' && req.method === 'GET')
    return json(res, 200, { recipes: listRecipes(), run: db.recipeRun || null });
  if (p === '/api/recipes/start' && req.method === 'POST') {
    startRecipe(await body(req), req);
    return json(res, 200, publicState());
  }
  if (p === '/api/recipes/continue' && req.method === 'POST') {
    continueRecipe(req);
    return json(res, 200, publicState());
  }
  if (p === '/api/recipes/stop' && req.method === 'POST') {
    stopRecipe();
    return json(res, 200, publicState());
  }
  if (p === '/api/recipes/save' && req.method === 'POST') {
    const saved = saveRecipe(await body(req));
    return json(res, 200, { saved, recipes: listRecipes() });
  }
  if (p === '/api/recipes/delete' && req.method === 'POST') {
    deleteRecipe(String((await body(req)).id || ''));
    return json(res, 200, { recipes: listRecipes() });
  }
  return NEXT;
}
