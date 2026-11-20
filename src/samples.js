'use strict';
/**
 * Recipe shape recovered from libBrewie.so (Recipe::calculate, getHops, getMashSteps,
 * createInstructions). Units: amounts kg, water L, temperatures °C, times minutes.
 *
 *  fermentables: [ [ {name, amount, color(°L), yield(ppg), mashable, category} ], ... ]   one inner list per Brewie bag
 *  hops:         [ [ {name, amount, alpha, time} ], [..], [..], [..] ]                    one inner list per hop cage (4)
 *  mash:         { mashInWater, mashInTemperature, mashSteps: [ [ {stepTemp, stepTime} ] ],
 *                  spargingWater?, spargingTemperature?, spargingTime? }
 *  fermentation: [ { ingredients: [ {category:'yeast', name, attenuation, ...} ], temp, time } ]
 *  delayedHoppingTime (min), coolingTemperature (°C), style (BJCP entry), estOG/estFG/estABV/estColor/IBU/efficiency
 */
function sampleRecipes() {
  return [
    {
      id: '5a1f0c2e9b7d4e61a3c8f00d12e4b7a1', path: '/recipes/5a1f0c2e9b7d4e61a3c8f00d12e4b7a1', name: 'House Pale Ale',
      style: { name: 'American Pale Ale', category: 'Pale American Ale', categoryNumber: '18', styleLetter: 'B', ogMin: 1.045, ogMax: 1.06, fgMin: 1.01, fgMax: 1.015, abvMin: 4.5, abvMax: 6.2, ibuMin: 30, ibuMax: 50, colorMin: 5, colorMax: 10 },
      batchSize: 18, efficiency: 0.65, estOG: 1.05, estFG: 1.012, estABV: 5.0, estColor: 6.5, IBU: 38,
      fermentables: [[
        { name: 'Pale Malt (2 Row) US', amount: 3.6, color: 2, yield: 36 },
        { name: 'Caramel/Crystal Malt - 20L', amount: 0.35, color: 20, yield: 35 },
        { name: 'Munich Malt', amount: 0.25, color: 9, yield: 37 },
      ]],
      mash: { mashInWater: 24, mashInTemperature: 67, mashSteps: [[{ stepTemp: 66, stepTime: 60 }, { stepTemp: 76, stepTime: 10 }]], spargingWater: 4, spargingTemperature: 76, spargingTime: 10 },
      hops: [[{ name: 'Magnum', amount: 0.012, alpha: 13, time: 60 }], [{ name: 'Cascade', amount: 0.025, alpha: 6, time: 15 }], [{ name: 'Citra', amount: 0.025, alpha: 12, time: 5 }], []],
      delayedHoppingTime: 0, coolingTemperature: 20,
      fermentation: [{ ingredients: [{ category: 'yeast', name: 'American Ale Yeast WLP001', brand: 'White Labs', attenuation: 76.5 }], temp: 19, time: 14 }],
    },
    {
      id: 'c03e2f7b18a94d55b6e90a7c4d21f8e3', path: '/recipes/c03e2f7b18a94d55b6e90a7c4d21f8e3', name: 'Weekend Hefeweizen',
      style: { name: 'Weissbier', category: 'German Wheat Beer', categoryNumber: '10', styleLetter: 'A', ogMin: 1.044, ogMax: 1.053, fgMin: 1.008, fgMax: 1.014, abvMin: 4.3, abvMax: 5.6, ibuMin: 8, ibuMax: 15, colorMin: 2, colorMax: 6 },
      batchSize: 18, efficiency: 0.65, estOG: 1.048, estFG: 1.011, estABV: 4.8, estColor: 3.5, IBU: 13,
      fermentables: [[
        { name: 'Wheat Malt, Ger', amount: 2.3, color: 2, yield: 39 },
        { name: 'Pilsner (2 Row) Ger', amount: 1.7, color: 2, yield: 37 },
      ]],
      mash: { mashInWater: 23, mashInTemperature: 52, mashSteps: [[{ stepTemp: 50, stepTime: 15 }, { stepTemp: 64, stepTime: 40 }, { stepTemp: 72, stepTime: 20 }]] },
      hops: [[{ name: 'Hallertauer Mittelfrueh', amount: 0.02, alpha: 4, time: 60 }], [], [], []],
      delayedHoppingTime: 0, coolingTemperature: 18,
      fermentation: [{ ingredients: [{ category: 'yeast', name: 'Hefeweizen Ale Yeast WLP300', brand: 'White Labs', attenuation: 74 }], temp: 18, time: 10 }],
    },
  ];
}

function blankRecipe(id) {
  return {
    // mirrors the template the Brewie itself ships (cf. "Dark Monk"): placeholder amounts and cage times
    id, path: `/recipes/${id}`, name: 'New recipe',
    batchSize: 19.8, efficiency: 0.65, estOG: 1.0, estColor: 0, IBU: 0,
    fermentables: [[]],
    mash: { mashInWater: 17, mashInTemperature: 67, mashSteps: [[{ stepTemp: 66, stepTime: 60 }]], spargingWater: 10, spargingTemperature: 78, spargingTime: 20 },
    hops: [[{ time: 60 }], [{ time: 30 }], [{ time: 15 }], [{ time: 5 }]], delayedHoppingTime: 0, coolingTemperature: 20,
  };
}

/** The Brewie's own AutomaticShortClean program (instruction list), copied from the machine. */
const SHORT_CLEAN_INSTRUCTIONS = [[7,72,0,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,8,6,4,true,true],[7,72,1,true,true,true,0,0,true,true,true,true,true,0,false,0,0,0,30,6,4,true,true],[7,72,2,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,3,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,4,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,5,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,6,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,7,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,8,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,9,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,10,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,11,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,12,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,13,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,14,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,15,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,16,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,17,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,18,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,19,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,20,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,21,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,22,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,23,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,24,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,25,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,26,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,27,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,28,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,29,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,9,6,4,true,true],[7,72,30,false,true,true,0,0,true,true,true,true,true,0,false,0,0,0,2,6,4,true,true],[7,72,31,false,true,true,0,0,true,true,true,true,true,0,true,0,255,0,2,6,4,true,true],[7,72,32,true,true,true,0,0,true,true,true,true,true,0,true,255,255,0,30,6,4,true,true],[7,76,33,false,false,false,0,0,true,true,true,true,true,0,true,0,0,0,30,6,0,false,false],[7,76,34,false,false,false,0,0,false,false,false,false,false,0,true,0,255,0,300,5,0,false,true],[7,76,35,false,false,false,0,0,false,false,false,false,false,0,true,255,0,0,300,4,0,true,false],[7,76,36,false,false,false,0,0,false,false,false,false,false,0,false,0,0,0,0,8,0,false,false]];

module.exports = { sampleRecipes, blankRecipe, SHORT_CLEAN_INSTRUCTIONS };
