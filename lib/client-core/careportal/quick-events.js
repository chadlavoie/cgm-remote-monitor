'use strict';

var presets = [
  { id: 'correction-5', name: '5u correction', detail: '5u fast acting insulin now', insulin: 5 }
  , { id: 'correction-10', name: '10u correction', detail: '10u fast acting insulin now', insulin: 10 }
  , { id: 'correction-20', name: '20u correction', detail: '20u fast acting insulin now', insulin: 20 }
  , { id: 'breakfast', name: 'Breakfast', detail: '40g carbs, 20g fat · 20u bolus 20 minutes earlier', carbs: 40, fat: 20, insulin: 20 }
  , { id: 'lunch', name: 'Lunch', detail: '30g carbs · 10u bolus 20 minutes earlier', carbs: 30, insulin: 10 }
  , { id: 'dinner-walk', name: 'Dinner + walk', detail: '60g carbs · 15u bolus 20 minutes earlier', carbs: 60, insulin: 15 }
];

function buildTreatments (id, now, enteredBy, units) {
  var preset = presets.find(function (item) { return item.id === id; });
  if (!preset) return null;

  var mealTime = new Date(now).getTime();
  var bolus = {
    eventType: 'Correction Bolus'
    , insulin: preset.insulin
    , created_at: new Date(mealTime).toISOString()
    , enteredBy: enteredBy
    , units: units
    , notes: preset.name
  };
  if (!preset.carbs) return [bolus];

  // Separate records keep nutrition at mealtime and insulin 20 minutes earlier.
  // No preBolus field: the server must not split these records a second time.
  bolus.eventType = 'Meal Bolus';
  bolus.created_at = new Date(mealTime - 20 * 60000).toISOString();
  bolus.notes = preset.name + ' — bolus 20 minutes before meal';
  var meal = {
    eventType: 'Meal Bolus'
    , carbs: preset.carbs
    , created_at: new Date(mealTime).toISOString()
    , enteredBy: enteredBy
    , units: units
    , notes: preset.name
  };
  if (preset.fat) meal.fat = preset.fat;
  return [bolus, meal];
}

module.exports = { presets: presets, buildTreatments: buildTreatments };
