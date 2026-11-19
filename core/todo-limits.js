/**
 * Task list limits, shared by /todo (commands/admin/todo.js) and the Task lists page's API
 * (dashboard/routes/api/features/todo.js), so a list made in either place fits the same embed.
 */
export const TODO_LIMITS = Object.freeze({
    title: 256,   // embed title
    task: 200,    // one line of the embed
    items: 50,    // keeps the list inside one embed description (4096 characters)
});

export default TODO_LIMITS;
