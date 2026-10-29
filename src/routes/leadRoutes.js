const express = require('express');
const router = express.Router();
const ConfigService = require('../services/configService');
const { ClientRepository, PersonRepository } = require('../db/models');

const DEFAULT_COLUMNS = [{ id: 'remarks', label: 'Remarks', createdAt: 'system' }];

async function getLeadColumns(clientId, config) {
  if (Array.isArray(config.leadColumns)) return config.leadColumns;
  await ClientRepository.set(clientId, { leadColumns: DEFAULT_COLUMNS });
  ConfigService.refreshCache(clientId);
  return DEFAULT_COLUMNS;
}

router.get('/api/leads', async (req, res) => {
  try {
    const clientId = req.query.clientId || 'grapelabs';
    const config = await ConfigService.getConfig(clientId);
    const [people, columns] = await Promise.all([
      PersonRepository.listByClient(clientId),
      getLeadColumns(clientId, config)
    ]);
    res.json({ success: true, columns, leads: people });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Could not load leads.' });
  }
});

router.post('/api/leads/columns', async (req, res) => {
  try {
    const clientId = req.body?.clientId || 'grapelabs';
    const label = String(req.body?.label || '').trim().slice(0, 40);
    if (!label) return res.status(400).json({ success: false, error: 'Enter a column name.' });
    const config = await ConfigService.getConfig(clientId);
    const columns = await getLeadColumns(clientId, config);
    if (columns.length >= 25) return res.status(400).json({ success: false, error: 'You can add up to 25 custom columns.' });
    if (columns.some(column => column.label.toLowerCase() === label.toLowerCase())) {
      return res.status(409).json({ success: false, error: 'A column with that name already exists.' });
    }
    const baseId = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'field';
    const id = `custom_${baseId}_${Date.now().toString(36)}`;
    const updatedColumns = [...columns, { id, label, createdAt: new Date().toISOString() }];
    await ClientRepository.set(clientId, { leadColumns: updatedColumns });
    ConfigService.refreshCache(clientId);
    res.json({ success: true, columns: updatedColumns });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Could not add the column.' });
  }
});

router.patch('/api/leads/:personId', async (req, res) => {
  try {
    const clientId = req.body?.clientId || 'grapelabs';
    const columnId = String(req.body?.columnId || '');
    const value = typeof req.body?.value === 'string' ? req.body.value.slice(0, 2000) : '';
    const config = await ConfigService.getConfig(clientId);
    const columns = await getLeadColumns(clientId, config);
    if (!columns.some(column => column.id === columnId)) {
      return res.status(400).json({ success: false, error: 'Unknown lead column.' });
    }
    const person = await PersonRepository.get(req.params.personId);
    if (!person || person.clientId !== clientId) return res.status(404).json({ success: false, error: 'Lead not found.' });
    const patch = columnId === 'remarks'
      ? { 'fields.notes': value }
      : { [`customFields.${columnId}`]: value };
    const lead = await PersonRepository.update(person.id, patch);
    res.json({ success: true, lead });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Could not save this lead field.' });
  }
});

router.delete('/api/leads/:personId', async (req, res) => {
  try {
    const clientId = req.query.clientId || 'grapelabs';
    const person = await PersonRepository.get(req.params.personId);
    if (!person || person.clientId !== clientId) return res.status(404).json({ success: false, error: 'Lead not found.' });
    const deletedRelatedRecords = await PersonRepository.deleteWithRelatedData(person.id);
    res.json({ success: true, deletedRelatedRecords });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Could not delete this lead.' });
  }
});

module.exports = router;
