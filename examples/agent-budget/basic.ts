import { judgeBudget } from '@j1nn0/agent-budget';

const withinBudget = judgeBudget({ consumed: 2, limit: 5 });
const atLimit = judgeBudget({ consumed: 5, limit: 5 });
const fractional = judgeBudget({ consumed: 2.5, limit: 3.75 });

console.log('within budget:', withinBudget);
console.log('at limit:', atLimit);
console.log('fractional:', fractional);
