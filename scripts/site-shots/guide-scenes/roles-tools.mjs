// Screenshots for the roles-tools guide. The page is dashboard/views/partials/manage/stat-roles.ejs with
// statroleConfigs and statroleGrantCounts shaped as dashboard/services/manage-sections.js passes them
// (role_id, stat_type, required_amount, remove_below; grant counts by role id).
export default async function ({ manage, demo }) {
    const { role } = demo;
    const statroleConfigs = [
        { id: 1, role_id: role.regulars.id, stat_type: 'messages', required_amount: 1000, remove_below: 0 },
        { id: 2, role_id: role.night.id, stat_type: 'voice_minutes', required_amount: 600, remove_below: 0 },
        { id: 3, role_id: role.members.id, stat_type: 'account_age_days', required_amount: 7, remove_below: 1 },
    ];
    const statroleGrantCounts = { [role.regulars.id]: 86, [role.night.id]: 23, [role.members.id]: 1190 };
    manage('roles-tools-page', 'stat-roles', { statroleConfigs, statroleGrantCounts }, {
        alt: 'The Stat roles page with three rules: Regulars at 1,000 messages, Night owls at 600 minutes in voice, and Members for accounts 7 days old.',
        guides: ['roles-tools'], height: 900, scrollTo: '#sr-rules-title',
    });
}
