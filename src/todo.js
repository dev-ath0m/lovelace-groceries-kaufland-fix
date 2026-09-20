import {
  localize,
  parseMultiplier,
  detectStoreLabel,
  formatTodoItemName,
  normalizeOffer,
  toIsoDateString
} from './utils.js';

// homeassistant.components.todo.TodoListEntityFeature bit flags
const TODO_FEATURE_SET_DUE_DATE = 16;
const TODO_FEATURE_SET_DESCRIPTION = 64;

export async function fetchTodoCounts(hass, config, getRawOffersForEntity) {
  if (!hass || !config?.todo?.todo_enabled) {
    return { counts: {}, customStoreTodoItems: {} };
  }
  const todoEntity = config.todo.todo_entity;
  const counts = {};
  const rawList = [];
  try {
    if (todoEntity) {
      const res = await hass.callWS({ type: 'todo/item/list', entity_id: todoEntity });
      (res?.items || []).forEach((item) => {
        if (item.status !== 'completed') {
          const { count, base } = parseMultiplier(item.summary);
          const key = base.toLowerCase();
          counts[key] = (counts[key] || 0) + count;
          rawList.push({ summary: item.summary, uid: item.uid, count, base });
        }
      });
    } else {
      const items = (await hass.callWS({ type: 'shopping_list/items' })) || [];
      items.forEach((item) => {
        if (!item.complete) {
          const { count, base } = parseMultiplier(item.name);
          const key = base.toLowerCase();
          counts[key] = (counts[key] || 0) + count;
          rawList.push({ summary: item.name, id: item.id, count, base });
        }
      });
    }
    const customStoreTodoItems = {};
    (config.entities || []).forEach((s) => {
      customStoreTodoItems[s.entity] = [];
      const label = detectStoreLabel(s.entity, hass).toLowerCase();
      const sensorOffers = getRawOffersForEntity(s.entity);
      const sensorNames = new Set(
        sensorOffers.map((o) => {
          const fmt = formatTodoItemName(o._name, o._displayPrice, s.entity, config, hass, o._storeLabel);
          return parseMultiplier(fmt).base.toLowerCase();
        })
      );
      rawList.forEach((todo) => {
        const baseLower = todo.base.toLowerCase();
        const matchesStore = label ? baseLower.includes(`(${label})`) : false;
        if ((matchesStore || config.entities.length === 1) && !sensorNames.has(baseLower)) {
          let cleanName = todo.base;
          if (label) cleanName = cleanName.replace(new RegExp(`\\s*\\(${label}\\)`, 'i'), '').trim();
          customStoreTodoItems[s.entity].push(
            normalizeOffer(
              {
                title: cleanName,
                category: localize('default.custom_items', hass),
                price: '',
                _isCustom: true
              },
              s.entity,
              hass,
              s
            )
          );
        }
      });
    });
    return { counts, customStoreTodoItems };
  } catch (err) {
    console.error('Failed to fetch todo list:', err);
    return { counts: {}, customStoreTodoItems: {} };
  }
}

export async function updateTodoQuantity(hass, config, itemName, itemPrice = '', mode = 'inc', customCount = null, entityId = '', dateFrom = '', dateTo = '', storeLabel = '') {
  if (!hass) return;
  const formattedItemName = formatTodoItemName(itemName, itemPrice, entityId, config, hass, storeLabel);
  const todoEntity = config.todo?.todo_entity;
  const target = parseMultiplier(formattedItemName);
  try {
    if (todoEntity) {
      const res = await hass.callWS({ type: 'todo/item/list', entity_id: todoEntity });
      const items = res?.items || [];
      const existing = items.find(
        (i) => i.status !== 'completed' && parseMultiplier(i.summary).base.toLowerCase() === target.base.toLowerCase()
      );
      const supportedFeatures = hass.states?.[todoEntity]?.attributes?.supported_features || 0;
      const dueDate = toIsoDateString(dateTo);
      const startDate = toIsoDateString(dateFrom);
      const applyDates = (serviceData) => {
        if (config.todo?.todo_due_date === false) return;
        // The service itself validates whether the target list supports these fields.
        // Do not gate them on the entity attribute: some HA todo providers expose
        // due-date support through the service while their state attributes lag behind.
        if (dueDate) {
          serviceData.due_date = dueDate;
        }
        if (startDate) {
          serviceData.description = localize('default.valid_from_description', hass).replace('{date}', startDate);
        }
      };
      if (existing) {
        const current = parseMultiplier(existing.summary);
        let nextCount = mode === 'inc' ? current.count + 1 : mode === 'dec' ? current.count - 1 : customCount;
        if (nextCount <= 0) {
          await hass.callService('todo', 'remove_item', { entity_id: todoEntity, item: [existing.uid] });
        } else {
          const newSummary = nextCount > 1 ? `${nextCount}x ${current.base}` : current.base;
          const serviceData = { entity_id: todoEntity, item: existing.uid, rename: newSummary };
          // Always apply the current offer dates. An existing todo may come from an older offer with a different validity period.
          applyDates(serviceData);
          await hass.callService('todo', 'update_item', serviceData);
        }
      } else if (mode === 'inc' || (mode === 'set' && customCount > 0)) {
        const count = mode === 'set' ? customCount : 1;
        const serviceData = {
          entity_id: todoEntity,
          item: count > 1 ? `${count}x ${target.base}` : target.base
        };
        // Home Assistant supports due_date directly when creating a Todo item.
        // Sending it with add_item avoids a race where an immediate list refresh
        // happens before the provider has exposed the newly-created item.
        // Create the item with the universally required field first. Some Todo
        // providers expose due-date/description support inconsistently in their
        // entity attributes. Sending optional fields in the initial add call can
        // therefore make the whole add fail even though the item itself is valid.
        await hass.callService('todo', 'add_item', serviceData);

        // Apply optional offer metadata after creation. This keeps the + button
        // functional for aggregated offers and providers with partial Todo API
        // support, while still preserving due dates where the service supports them.
        if (dueDate || startDate) {
          try {
            const refreshed = await hass.callWS({ type: 'todo/item/list', entity_id: todoEntity });
            const created = (refreshed?.items || []).find(
              (i) => i.status !== 'completed' && i.summary === serviceData.item
            );
            if (created) {
              const metadata = { entity_id: todoEntity, item: created.uid };
              if (dueDate) metadata.due_date = dueDate;
              if (startDate) {
                metadata.description = localize('default.valid_from_description', hass).replace('{date}', startDate);
              }
              await hass.callService('todo', 'update_item', metadata);
            }
          } catch (metadataError) {
            console.warn('Todo item added, but offer metadata could not be applied:', metadataError);
          }
        }
      }
    } else {
      const items = (await hass.callWS({ type: 'shopping_list/items' })) || [];
      const existing = items.find(
        (i) => !i.complete && parseMultiplier(i.name).base.toLowerCase() === target.base.toLowerCase()
      );
      if (existing) {
        const current = parseMultiplier(existing.name);
        let nextCount = mode === 'inc' ? current.count + 1 : mode === 'dec' ? current.count - 1 : customCount;
        if (nextCount <= 0) {
          await hass.callWS({ type: 'shopping_list/remove_item', item_id: existing.id });
        } else {
          const newName = nextCount > 1 ? `${nextCount}x ${current.base}` : current.base;
          await hass.callWS({ type: 'shopping_list/update_item', item_id: existing.id, name: newName });
        }
      } else if (mode === 'inc' || (mode === 'set' && customCount > 0)) {
        const count = mode === 'set' ? customCount : 1;
        await hass.callService('shopping_list', 'add_item', {
          name: count > 1 ? `${count}x ${target.base}` : target.base
        });
      }
    }
  } catch (err) {
    console.error('Failed to update shopping list item quantity:', err);
  }
}

export async function clearStoreTodoItems(hass, config, storeEntity, storeOffers, customOffers) {
  if (!hass || !config.todo?.todo_enabled) return;
  const allStoreOffers = [...storeOffers, ...customOffers];
  const storeKeys = new Set(
    allStoreOffers.map((item) => {
      const formattedName = formatTodoItemName(item._name, item._displayPrice, storeEntity, config, hass, item._storeLabel);
      return parseMultiplier(formattedName).base.toLowerCase();
    })
  );
  const todoEntity = config.todo?.todo_entity;
  try {
    if (todoEntity) {
      const res = await hass.callWS({ type: 'todo/item/list', entity_id: todoEntity });
      const uidsToRemove = (res?.items || [])
        .filter((i) => i.status !== 'completed' && storeKeys.has(parseMultiplier(i.summary).base.toLowerCase()))
        .map((i) => i.uid);
      if (uidsToRemove.length > 0) {
        await hass.callService('todo', 'remove_item', { entity_id: todoEntity, item: uidsToRemove });
      }
    } else {
      const items = (await hass.callWS({ type: 'shopping_list/items' })) || [];
      const toRemove = items.filter((i) => !i.complete && storeKeys.has(parseMultiplier(i.name).base.toLowerCase()));
      for (const item of toRemove) {
        await hass.callWS({ type: 'shopping_list/remove_item', item_id: item.id });
      }
    }
  } catch (err) {
    console.error('Failed to clear store shopping list items:', err);
  }
}