// Website entry (build.mjs --web): the game itself, then the website-only modules. The Twitch panel is built from
// main.js alone, so nothing imported here can change the panel package (register H-641: the panel was in Twitch
// review when the "Your data" card was added, and any change to it would have withdrawn the review).
// main.js first: slots render in the order they were filled, so the card comes after the achievements card.
// Nothing is drawn before the first network answer, so the card is registered before the Profile tab can show.
// web-theme.js first: it only reads <html> (the site theme the route put there) and follows the OS for Auto.
import './web-theme.js';
import './main.js';
import './views/your-data.js';
