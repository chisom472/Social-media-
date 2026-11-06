// Registry of dropshipping platforms. Only platforms that are trusted, used worldwide and have warehouses/production in many
// countries are listed. Adding another one = one new file with the same shape and one line here.
const list = [require('./printful'), require('./printify'), require('./cj')];
const byId = Object.fromEntries(list.map(a => [a.id, a]));
module.exports = {
  all: list, byId, get: id => byId[id] || null,
  enabled: () => list.filter(a => a.enabled()),
  describe: () => list.map(a => ({ id: a.id, label: a.label, kind: a.kind, about: a.about, branding: a.branding, mockup: !!a.mockup, enabled: a.enabled(), needs_option: a.needsOption || null }))
};
