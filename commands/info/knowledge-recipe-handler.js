import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

export async function handleSearch(interaction) {
  const query = interaction.options.getString('query');
  const url = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(query)}`;
  return handleMealResult(interaction, url, false);
}

export async function handleRandom(interaction) {
  const url = 'https://www.themealdb.com/api/json/v1/1/random.php';
  return handleMealResult(interaction, url, false);
}

export async function handleIngredient(interaction) {
  const ingredient = interaction.options.getString('ingredient');
  const url = `https://www.themealdb.com/api/json/v1/1/filter.php?i=${encodeURIComponent(ingredient)}`;
  return handleMealResult(interaction, url, true);
}

export async function handleCocktail(interaction) {
  const name = interaction.options.getString('name');
  const url = `https://www.thecocktaildb.com/api/json/v1/1/search.php?s=${encodeURIComponent(name)}`;
  return handleCocktailResult(interaction, url);
}

export async function handleRandomCocktail(interaction) {
  const url = 'https://www.thecocktaildb.com/api/json/v1/1/random.php';
  return handleCocktailResult(interaction, url);
}

async function handleMealResult(interaction, url, isIngredientSearch) {
  const response = await axios.get(url, { timeout: 10000 });

  if (!response.data.meals || response.data.meals.length === 0) {
    return interaction.editReply({ content: '❌ No recipes found. Try a different search term.', ephemeral: true });
  }

  const meal = response.data.meals[0];

  if (isIngredientSearch) {
    const detailsResponse = await axios.get(
      `https://www.themealdb.com/api/json/v1/1/lookup.php?i=${meal.idMeal}`,
      { timeout: 5000 }
    );
    if (detailsResponse.data.meals && detailsResponse.data.meals.length > 0) {
      Object.assign(meal, detailsResponse.data.meals[0]);
    }
  }

  const ingredients = [];
  for (let i = 1; i <= 20; i++) {
    const ingredient = meal[`strIngredient${i}`];
    const measure = meal[`strMeasure${i}`];
    if (ingredient && ingredient.trim()) {
      ingredients.push(`${measure ? measure.trim() : ''} ${ingredient.trim()}`);
    }
  }

  const instructions = meal.strInstructions
    ? (meal.strInstructions.length > 1024 ? meal.strInstructions.substring(0, 1021) + '...' : meal.strInstructions)
    : 'No instructions available';

  const embed = new EmbedBuilder()
    .setColor('#FF6B35')
    .setTitle(`🍳 ${meal.strMeal}`)
    .setThumbnail(meal.strMealThumb || null)
    .addFields(
      { name: '📍 Category', value: meal.strCategory || 'Unknown', inline: true },
      { name: '🌍 Cuisine', value: meal.strArea || 'Unknown', inline: true },
      { name: '📝 Ingredients', value: ingredients.slice(0, 10).join('\n') || 'Not available', inline: false }
    );

  if (instructions) embed.addFields({ name: '👨‍🍳 Instructions', value: instructions });
  if (meal.strYoutube) embed.addFields({ name: '📺 Video Tutorial', value: `[Watch on YouTube](${meal.strYoutube})` });
  if (meal.strSource) embed.setURL(meal.strSource);

  embed.setFooter({ text: 'Powered by TheMealDB' }).setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

async function handleCocktailResult(interaction, url) {
  const response = await axios.get(url, { timeout: 10000 });

  if (!response.data.drinks || response.data.drinks.length === 0) {
    return interaction.editReply({ content: '❌ No cocktails found. Try a different search term.', ephemeral: true });
  }

  const drink = response.data.drinks[0];

  const ingredients = [];
  for (let i = 1; i <= 15; i++) {
    const ingredient = drink[`strIngredient${i}`];
    const measure = drink[`strMeasure${i}`];
    if (ingredient && ingredient.trim()) {
      ingredients.push(`${measure ? measure.trim() : ''} ${ingredient.trim()}`);
    }
  }

  const embed = new EmbedBuilder()
    .setColor('#8E44AD')
    .setTitle(`🍸 ${drink.strDrink}`)
    .setThumbnail(drink.strDrinkThumb || null)
    .addFields(
      { name: '🏷️ Category', value: drink.strCategory || 'Unknown', inline: true },
      { name: '🥃 Type', value: drink.strAlcoholic || 'Unknown', inline: true },
      { name: '🥄 Glass', value: drink.strGlass || 'Any glass', inline: true },
      { name: '📝 Ingredients', value: ingredients.join('\n') || 'Not available', inline: false }
    );

  if (drink.strInstructions) {
    const instructions = drink.strInstructions.length > 1024
      ? drink.strInstructions.substring(0, 1021) + '...'
      : drink.strInstructions;
    embed.addFields({ name: '🍹 Instructions', value: instructions });
  }

  embed.setFooter({ text: 'Powered by TheCocktailDB • Drink Responsibly' }).setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}
