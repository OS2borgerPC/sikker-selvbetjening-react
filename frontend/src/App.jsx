import { JsonForms } from '@jsonforms/react';
import { materialCells, materialRenderers } from '@jsonforms/material-renderers';
import { useEffect, useMemo, useState } from 'react';
import { JsonFormsDispatch, withJsonFormsControlProps, withJsonFormsLayoutProps } from '@jsonforms/react';
import { isStringControl, optionIs, rankWith, uiTypeIs, and } from '@jsonforms/core';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Box,
  Button,
  FormHelperText,
  FormLabel,
  Grid,
  TextField,
} from '@mui/material';
import { ExpandMore } from '@mui/icons-material';

const defaultPath = 'config/groups.yml';

const normalizeGroupName = (name) => {
  const value = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  if (!value) {
    return 'new-group';
  }

  if (!/^[a-z]/.test(value)) {
    return `g-${value}`;
  }

  return value;
};

const normalizeBuildTargetName = (name) => {
  const value = String(name || '').trim();
  return value || 'new-target';
};

const normalizeImageName = (name) => {
  const cleaned = String(name || '')
    .replace(/[^A-Za-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (!cleaned) {
    return 'NewTarget';
  }

  if (!/^[A-Za-z_]/.test(cleaned)) {
    return `T_${cleaned}`;
  }

  return cleaned;
};

const buildUniqueName = (existingNames, preferredName, normalize) => {
  const used = new Set(existingNames.filter(Boolean));
  const base = normalize(preferredName);

  if (!used.has(base)) {
    return base;
  }

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return `${base}-${suffix}`;
};

const makeDefaultGroup = (preferredName = 'new-group') => ({
  name: normalizeGroupName(preferredName),
});

const makeDefaultBuildTarget = (preferredName = 'new-target', groupName = 'new-group') => {
  const normalizedTargetName = normalizeBuildTargetName(preferredName);
  return {
    name: normalizedTargetName,
    groups: [groupName],
    image_name: normalizeImageName(normalizedTargetName),
  };
};

const createDefaultData = (domainName = 'default') => ({
  domains: [
    {
      domain: domainName,
      groups: [],
      build_targets: [],
    },
  ],
});

const ensureEditableDomain = (payload, domainName) => {
  const activeDomainName = String(domainName || '').trim() || 'default';
  const source = payload && typeof payload === 'object' ? payload : {};
  const domains = getDomains(source);
  let hasCurrentDomain = false;

  const nextDomains = domains.map((domain) => {
    if (domain?.domain === activeDomainName) {
      hasCurrentDomain = true;
    }

    return {
      ...(domain && typeof domain === 'object' ? domain : {}),
      groups: getDomainGroups(domain),
      build_targets: getDomainBuildTargets(domain),
    };
  });

  if (!hasCurrentDomain) {
    nextDomains.push({
      domain: activeDomainName,
      groups: [],
      build_targets: [],
    });
  }

  return {
    ...source,
    domains: nextDomains,
  };
};

const getDomains = (payload) => {
  if (payload && Array.isArray(payload.domains)) {
    return payload.domains;
  }

  return [];
};

const getDomainGroups = (domain) => {
  if (domain && Array.isArray(domain.groups)) {
    return domain.groups;
  }

  return [];
};

const getDomainBuildTargets = (domain) => {
  if (domain && Array.isArray(domain.build_targets)) {
    return domain.build_targets;
  }

  return [];
};

const sanitizeGroup = (group) => {
  if (!group || typeof group !== 'object') {
    return group;
  }

  const nextGroup = { ...group };
  if (nextGroup.desktop && typeof nextGroup.desktop === 'object') {
    const desktop = { ...nextGroup.desktop };

    if (Array.isArray(desktop.shortcuts_in_menu)) {
      // Normalize shortcut values and drop empty entries before persisting.
      const cleanedShortcuts = desktop.shortcuts_in_menu
        .map((shortcut) => String(shortcut || '').trim())
        .filter((shortcut) => shortcut.length > 0);

      if (cleanedShortcuts.length > 0) {
        desktop.shortcuts_in_menu = cleanedShortcuts;
      } else {
        delete desktop.shortcuts_in_menu;
      }
    }

    nextGroup.desktop = desktop;
  }

  return nextGroup;
};

const sanitizePayload = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const domains = getDomains(payload).map((domain) => ({
    ...domain,
    groups: getDomainGroups(domain).map((group) => sanitizeGroup(group)),
  }));

  return {
    ...payload,
    domains,
  };
};

const CollapsibleGroupLayoutRenderer = withJsonFormsLayoutProps(
  ({ visible, enabled, uischema, schema, path, renderers, cells, label }) => {
    const [expanded, setExpanded] = useState(false);

    if (!visible) {
      return null;
    }

    const elements = Array.isArray(uischema?.elements) ? uischema.elements : [];
    if (elements.length === 0) {
      return null;
    }

    return (
      <Accordion
        disableGutters
        expanded={expanded}
        onChange={(_event, isExpanded) => setExpanded(isExpanded)}
      >
        <AccordionSummary expandIcon={<ExpandMore />}>
          {label || ''}
        </AccordionSummary>
        <AccordionDetails>
          <Grid container direction="column" spacing={0}>
            {elements.map((child, index) => (
              <Grid key={`${path}-${index}`} size="grow">
                <JsonFormsDispatch
                  uischema={child}
                  schema={schema}
                  path={path}
                  enabled={enabled}
                  renderers={renderers}
                  cells={cells}
                />
              </Grid>
            ))}
          </Grid>
        </AccordionDetails>
      </Accordion>
    );
  }
);

const collapsibleGroupRendererEntry = {
  tester: rankWith(3, uiTypeIs('Group')),
  renderer: CollapsibleGroupLayoutRenderer,
};

const FilePathControl = withJsonFormsControlProps(
  ({
    data,
    path,
    handleChange,
    uischema,
    label,
    description,
    errors,
    enabled,
    visible,
    required,
    config,
  }) => {
    if (!visible) {
      return null;
    }

    const options = uischema?.options || {};
    const accept = typeof options.accept === 'string' ? options.accept : '*/*';
    const domainFromConfig =
      typeof config?.currentDomain === 'string' && config.currentDomain.trim()
        ? config.currentDomain.trim()
        : '';
    const assetPrefixTemplate =
      typeof options.assetPrefixTemplate === 'string'
        ? options.assetPrefixTemplate
        : typeof options.assetPrefix === 'string'
          ? options.assetPrefix
          : 'assets/{domain}/';
    const resolvedPrefix = assetPrefixTemplate.includes('{domain}')
      ? assetPrefixTemplate.replaceAll('{domain}', domainFromConfig || 'default')
      : assetPrefixTemplate;
    const assetPrefix = resolvedPrefix.endsWith('/') ? resolvedPrefix : `${resolvedPrefix}/`;
    const hasErrors = Boolean(errors && errors.length > 0);

    const handleFilePick = (event) => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      handleChange(path, `${assetPrefix}${file.name}`);
      event.target.value = '';
    };

    return (
      <Box sx={{ marginBottom: 2 }}>
        <FormLabel>
          {label}
          {required ? ' *' : ''}
        </FormLabel>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', marginTop: 0.75 }}>
          <TextField
            fullWidth
            value={data || ''}
            onChange={(event) => handleChange(path, event.target.value)}
            disabled={!enabled}
            error={hasErrors}
          />
          <Button component="label" variant="outlined" disabled={!enabled}>
            Browse
            <input hidden type="file" accept={accept} onChange={handleFilePick} />
          </Button>
        </Box>
        {hasErrors ? (
          <FormHelperText error>{errors}</FormHelperText>
        ) : description ? (
          <FormHelperText>{description}</FormHelperText>
        ) : null}
      </Box>
    );
  }
);

const filePathControlRendererEntry = {
  tester: rankWith(5, and(isStringControl, optionIs('widget', 'file'))),
  renderer: FilePathControl,
};

const buildFallbackUiSchema = (schema) => {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const keys = Object.keys(properties);
  const orderedKeys = ['name', ...keys.filter((key) => key !== 'name')];

  return {
    type: 'VerticalLayout',
    elements: orderedKeys.map((key) => ({
      type: 'Control',
      scope: `#/properties/${key}`,
    })),
  };
};

const applyRenameVisibility = (uiSchema, showRenameField) => {
  if (!uiSchema || typeof uiSchema !== 'object') {
    return null;
  }

  if (showRenameField) {
    return uiSchema;
  }

  const removeNameControl = (node) => {
    if (!node || typeof node !== 'object') {
      return node;
    }

    const nextNode = { ...node };
    if (Array.isArray(nextNode.elements)) {
      nextNode.elements = nextNode.elements
        .filter((element) => !(element?.type === 'Control' && element?.scope === '#/properties/name'))
        .map((element) => removeNameControl(element));
    }

    return nextNode;
  };

  return removeNameControl(uiSchema);
};

function App() {
  const [data, setData] = useState(createDefaultData());
  const path = defaultPath;
  const [groupsSchema, setGroupsSchema] = useState(null);
  const [buildTargetsSchema, setBuildTargetsSchema] = useState(null);
  const [groupsUiSchemaTemplate, setGroupsUiSchemaTemplate] = useState(null);
  const [buildTargetsUiSchemaTemplate, setBuildTargetsUiSchemaTemplate] = useState(null);
  const [availableDomains, setAvailableDomains] = useState([]);
  const [currentDomain, setCurrentDomain] = useState('default');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState({ type: 'idle', text: '' });
  const [validationErrors, setValidationErrors] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeEditorTab, setActiveEditorTab] = useState('groups');
  const [showRenameField, setShowRenameField] = useState(false);
  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);
  const [selectedBuildTargetIndex, setSelectedBuildTargetIndex] = useState(0);

  const domains = useMemo(() => getDomains(data), [data]);
  const activeDomainIndex = useMemo(() => {
    if (domains.length === 0) {
      return -1;
    }

    const configuredIndex = domains.findIndex((domain) => domain?.domain === currentDomain);
    if (configuredIndex >= 0) {
      return configuredIndex;
    }

    return 0;
  }, [domains, currentDomain]);
  const selectedDomain = activeDomainIndex >= 0 ? domains[activeDomainIndex] : null;
  const domainGroups = useMemo(() => getDomainGroups(selectedDomain), [selectedDomain]);
  const domainBuildTargets = useMemo(
    () => getDomainBuildTargets(selectedDomain),
    [selectedDomain]
  );
  const selectedGroup = domainGroups[selectedGroupIndex] || null;
  const selectedBuildTarget = domainBuildTargets[selectedBuildTargetIndex] || null;

  const domainItemSchema = groupsSchema?.properties?.domains?.items || null;
  const groupItemSchema = domainItemSchema?.properties?.groups?.items || null;
  const buildTargetItemSchema = buildTargetsSchema?.properties?.domains?.items?.properties?.build_targets?.items || null;

  const groupEditorSchema = useMemo(() => {
    if (!groupItemSchema) {
      return null;
    }

    return {
      $defs: groupsSchema?.$defs || {},
      ...groupItemSchema,
    };
  }, [groupItemSchema, groupsSchema]);

  const buildTargetEditorSchema = useMemo(() => {
    if (!buildTargetItemSchema) {
      return null;
    }

    return {
      ...buildTargetItemSchema,
    };
  }, [buildTargetItemSchema]);

  const renderers = useMemo(
    () => [filePathControlRendererEntry, collapsibleGroupRendererEntry, ...materialRenderers],
    []
  );
  const jsonFormsConfig = useMemo(
    () => ({ currentDomain: selectedDomain?.domain || currentDomain || 'default' }),
    [selectedDomain, currentDomain]
  );
  const groupEditorUiSchema = useMemo(() => {
    const baseUiSchema = groupsUiSchemaTemplate || buildFallbackUiSchema(groupEditorSchema);
    return applyRenameVisibility(baseUiSchema, showRenameField);
  }, [groupsUiSchemaTemplate, groupEditorSchema, showRenameField]);
  const buildTargetEditorUiSchema = useMemo(
    () => buildTargetsUiSchemaTemplate || buildFallbackUiSchema(buildTargetEditorSchema),
    [buildTargetsUiSchemaTemplate, buildTargetEditorSchema]
  );

  const saveDisabled = useMemo(() => !path.trim() || domains.length === 0, [path, domains.length]);

  useEffect(() => {
    const controller = new AbortController();

    const loadInitialData = async () => {
      setIsLoading(true);
      setStatus({ type: 'loading', text: 'Loading schemas and existing YAML...' });
      setValidationErrors([]);

      try {
        const [schemasResponse, fileResponse] = await Promise.all([
          fetch('/api/schemas', { signal: controller.signal }),
          fetch(`/api/file?path=${encodeURIComponent(path)}`, { signal: controller.signal }),
        ]);

        const schemasResult = await schemasResponse.json();
        if (!schemasResponse.ok) {
          throw new Error(schemasResult.error || 'Failed to load schemas');
        }

        setGroupsSchema(schemasResult.groupsSchema);
        setBuildTargetsSchema(schemasResult.buildTargetsSchema);
        setGroupsUiSchemaTemplate(schemasResult.groupsUiSchema || null);
        setBuildTargetsUiSchemaTemplate(schemasResult.buildTargetsUiSchema || null);
        setAvailableDomains(
          Array.isArray(schemasResult.availableDomains) ? schemasResult.availableDomains : []
        );
        const nextCurrentDomain =
          typeof schemasResult.currentDomain === 'string' && schemasResult.currentDomain.trim()
            ? schemasResult.currentDomain.trim()
            : 'default';
        setCurrentDomain(nextCurrentDomain);

        if (fileResponse.status === 404) {
          setData(createDefaultData(nextCurrentDomain));
          setStatus({
            type: 'idle',
            text: 'groups.yml not found yet. Using a starter object with one domain.',
          });
          return;
        }

        const fileResult = await fileResponse.json();
        if (!fileResponse.ok) {
          throw new Error(fileResult.error || 'Failed to load config file');
        }

        setData(ensureEditableDomain(fileResult.parsed, nextCurrentDomain));
        setSelectedGroupIndex(0);
        setSelectedBuildTargetIndex(0);
        setStatus({ type: 'idle', text: 'Loaded config/groups.yml from GitHub.' });
      } catch (error) {
        if (error.name === 'AbortError') {
          return;
        }

        setStatus({
          type: 'error',
          text: error.message || 'Failed to load schemas/config from GitHub.',
        });
      } finally {
        setIsLoading(false);
      }
    };

    loadInitialData();

    return () => {
      controller.abort();
    };
  }, [path]);

  useEffect(() => {
    if (domains.length === 0) {
      if (selectedGroupIndex !== 0) {
        setSelectedGroupIndex(0);
      }
      if (selectedBuildTargetIndex !== 0) {
        setSelectedBuildTargetIndex(0);
      }
      return;
    }

    const currentDomain = activeDomainIndex >= 0 ? domains[activeDomainIndex] : null;
    const groups = getDomainGroups(currentDomain);
    const buildTargets = getDomainBuildTargets(currentDomain);

    // Keep item selections in range after add/remove operations.
    if (selectedGroupIndex > groups.length - 1) {
      setSelectedGroupIndex(Math.max(groups.length - 1, 0));
    }

    if (selectedBuildTargetIndex > buildTargets.length - 1) {
      setSelectedBuildTargetIndex(Math.max(buildTargets.length - 1, 0));
    }
  }, [domains, activeDomainIndex, selectedGroupIndex, selectedBuildTargetIndex]);

  useEffect(() => {
    setShowRenameField(false);
  }, [selectedGroupIndex]);

  const updateSelectedDomain = (domainUpdater) => {
    setData((prev) => {
      const prevDomains = getDomains(prev);
      if (prevDomains.length === 0) {
        return prev;
      }

      const targetDomainIndex = activeDomainIndex >= 0 ? activeDomainIndex : 0;
      if (targetDomainIndex > prevDomains.length - 1) {
        return prev;
      }

      return {
        ...prev,
        domains: prevDomains.map((domain, index) =>
          index === targetDomainIndex ? domainUpdater(domain) : domain
        ),
      };
    });
  };

  const handleGroupChange = (updatedGroup) => {
    updateSelectedDomain((domain) => ({
      ...domain,
      groups: getDomainGroups(domain).map((group, index) =>
        index === selectedGroupIndex ? updatedGroup : group
      ),
    }));
  };

  const addGroup = () => {
    updateSelectedDomain((domain) => {
      const currentGroups = getDomainGroups(domain);
      const nextGroupName = buildUniqueName(
        currentGroups.map((group) => group?.name),
        'new-group',
        normalizeGroupName
      );
      const nextGroups = [...currentGroups, makeDefaultGroup(nextGroupName)];
      setSelectedGroupIndex(nextGroups.length - 1);

      return {
        ...domain,
        groups: nextGroups,
      };
    });
  };

  const duplicateGroup = () => {
    if (!selectedGroup) {
      return;
    }

    updateSelectedDomain((domain) => {
      const currentGroups = getDomainGroups(domain);
      const insertIndex = selectedGroupIndex + 1;
      const preferredName = `${selectedGroup.name || 'group'}-copy`;
      const clone = {
        ...selectedGroup,
        name: buildUniqueName(
          currentGroups.map((group) => group?.name),
          preferredName,
          normalizeGroupName
        ),
      };
      const nextGroups = [
        ...currentGroups.slice(0, insertIndex),
        clone,
        ...currentGroups.slice(insertIndex),
      ];

      setSelectedGroupIndex(insertIndex);

      return {
        ...domain,
        groups: nextGroups,
      };
    });
  };

  const removeSelectedGroup = () => {
    if (!selectedGroup) {
      return;
    }

    updateSelectedDomain((domain) => ({
      ...domain,
      groups: getDomainGroups(domain).filter((_, index) => index !== selectedGroupIndex),
    }));
  };

  const handleBuildTargetChange = (updatedBuildTarget) => {
    updateSelectedDomain((domain) => ({
      ...domain,
      build_targets: getDomainBuildTargets(domain).map((target, index) =>
        index === selectedBuildTargetIndex ? updatedBuildTarget : target
      ),
    }));
  };

  const addBuildTarget = () => {
    updateSelectedDomain((domain) => {
      const currentTargets = getDomainBuildTargets(domain);
      const nextTargetName = buildUniqueName(
        currentTargets.map((target) => target?.name),
        'new-target',
        normalizeBuildTargetName
      );
      const fallbackGroupName =
        getDomainGroups(domain)[selectedGroupIndex]?.name || getDomainGroups(domain)[0]?.name || 'new-group';
      const nextTargets = [...currentTargets, makeDefaultBuildTarget(nextTargetName, fallbackGroupName)];
      setSelectedBuildTargetIndex(nextTargets.length - 1);

      return {
        ...domain,
        build_targets: nextTargets,
      };
    });
  };

  const duplicateBuildTarget = () => {
    if (!selectedBuildTarget) {
      return;
    }

    updateSelectedDomain((domain) => {
      const currentTargets = getDomainBuildTargets(domain);
      const insertIndex = selectedBuildTargetIndex + 1;
      const preferredName = `${selectedBuildTarget.name || 'target'}-copy`;
      const duplicateName = buildUniqueName(
        currentTargets.map((target) => target?.name),
        preferredName,
        normalizeBuildTargetName
      );
      const clone = {
        ...selectedBuildTarget,
        name: duplicateName,
        image_name: normalizeImageName(duplicateName),
      };
      const nextTargets = [
        ...currentTargets.slice(0, insertIndex),
        clone,
        ...currentTargets.slice(insertIndex),
      ];
      setSelectedBuildTargetIndex(insertIndex);

      return {
        ...domain,
        build_targets: nextTargets,
      };
    });
  };

  const removeSelectedBuildTarget = () => {
    if (!selectedBuildTarget) {
      return;
    }

    updateSelectedDomain((domain) => ({
      ...domain,
      build_targets: getDomainBuildTargets(domain).filter(
        (_, index) => index !== selectedBuildTargetIndex
      ),
    }));
  };

  const handleSave = async () => {
    setStatus({ type: 'loading', text: 'Saving to GitHub...' });
    setValidationErrors([]);
    // Sanitize right before save to avoid noisy form state changes while typing.
    const cleanedData = sanitizePayload(data);
    setData(cleanedData);

    try {
      const response = await fetch('/api/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          path,
          content: cleanedData,
          message,
        }),
      });

      const result = await response.json();

      if (!response.ok) {
        if (Array.isArray(result.validationErrors)) {
          setValidationErrors(result.validationErrors);
        }
        throw new Error(result.error || 'Save failed');
      }

      setStatus({
        type: 'success',
        text: `Saved. Commit: ${result.commitSha.slice(0, 7)}`,
      });
    } catch (error) {
      setStatus({
        type: 'error',
        text: error.message || 'Unexpected error while saving.',
      });
    }
  };

  return (
    <main className="app-shell">
      <section className="hero">
        <p className="eyebrow">Schema-Driven Content Ops</p>
        <h1>Git-backed Groups and Build Targets Editor</h1>
        <p>
          Edit config/groups.yml with domain-scoped groups and build targets, then validate against
          all active schemas before saving to GitHub.
        </p>
      </section>

      <section className="panel">
        <div className="domain-content">
          <p className="selected-group-title">Domain: {selectedDomain?.domain || 'N/A'}</p>
          <div className="editor-tabs" role="tablist" aria-label="Editor type">
            <button
              type="button"
              role="tab"
              className={`editor-tab ${activeEditorTab === 'groups' ? 'active' : ''}`}
              aria-selected={activeEditorTab === 'groups'}
              onClick={() => setActiveEditorTab('groups')}
            >
              Groups ({domainGroups.length})
            </button>
            <button
              type="button"
              role="tab"
              className={`editor-tab ${activeEditorTab === 'buildTargets' ? 'active' : ''}`}
              aria-selected={activeEditorTab === 'buildTargets'}
              onClick={() => setActiveEditorTab('buildTargets')}
            >
              Build Targets ({domainBuildTargets.length})
            </button>
          </div>

            {activeEditorTab === 'groups' ? (
              <section className="entity-editor">
                <div className="master-detail">
                  <div className="group-list-wrap">
                    <div className="group-list-header">
                      <h2>Groups</h2>
                      <span>{domainGroups.length}</span>
                    </div>

                    <div className="group-list-actions">
                      <button type="button" className="secondary" onClick={addGroup} disabled={isLoading}>
                        Add
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={duplicateGroup}
                        disabled={isLoading || !selectedGroup}
                      >
                        Duplicate
                      </button>
                      <button
                        type="button"
                        className="secondary danger"
                        onClick={removeSelectedGroup}
                        disabled={isLoading || !selectedGroup}
                      >
                        Remove
                      </button>
                    </div>

                    <ul className="group-list" aria-label="Group list">
                      {domainGroups.map((group, index) => {
                        const groupName = group?.name || `group-${index + 1}`;
                        const isActive = index === selectedGroupIndex;

                        return (
                          <li key={`${groupName}-${index}`}>
                            <button
                              type="button"
                              className={`group-item ${isActive ? 'active' : ''}`}
                              onClick={() => setSelectedGroupIndex(index)}
                            >
                              <span className="group-item-name">{groupName}</span>
                              <span className="group-item-index">#{index + 1}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>

                  <div className="form-wrap">
                    {isLoading || !groupEditorSchema ? (
                      <p className="placeholder">Loading groups schema...</p>
                    ) : !selectedGroup ? (
                      <p className="placeholder">No groups in this domain yet. Add one to start editing.</p>
                    ) : (
                      <>
                        <div className="selected-group-header">
                          <p className="selected-group-title">Editing Group: {selectedGroup.name || 'Unnamed'}</p>
                          <button
                            type="button"
                            className="rename-toggle"
                            onClick={() => setShowRenameField((prev) => !prev)}
                          >
                            {showRenameField ? 'Done' : 'Rename'}
                          </button>
                        </div>
                        <JsonForms
                          schema={groupEditorSchema}
                          uischema={groupEditorUiSchema || undefined}
                          data={selectedGroup}
                          config={jsonFormsConfig}
                          renderers={renderers}
                          cells={materialCells}
                          onChange={({ data: updatedGroup }) => handleGroupChange(updatedGroup)}
                        />
                      </>
                    )}
                  </div>
                </div>
              </section>
            ) : (
              <section className="entity-editor">
                <div className="group-list-wrap">
                  <div className="group-list-header">
                    <h2>Build Targets</h2>
                    <span>{domainBuildTargets.length}</span>
                  </div>

                  <div className="group-list-actions">
                    <button
                      type="button"
                      className="secondary"
                      onClick={addBuildTarget}
                      disabled={isLoading}
                    >
                      Add
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={duplicateBuildTarget}
                      disabled={isLoading || !selectedBuildTarget}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="secondary danger"
                      onClick={removeSelectedBuildTarget}
                      disabled={isLoading || !selectedBuildTarget}
                    >
                      Remove
                    </button>
                  </div>

                  <ul className="group-list" aria-label="Build target list">
                    {domainBuildTargets.map((target, index) => {
                      const targetName = target?.name || `target-${index + 1}`;
                      const isActive = index === selectedBuildTargetIndex;

                      return (
                        <li key={`${targetName}-${index}`}>
                          <button
                            type="button"
                            className={`group-item ${isActive ? 'active' : ''}`}
                            onClick={() => setSelectedBuildTargetIndex(index)}
                          >
                            <span className="group-item-name">{targetName}</span>
                            <span className="group-item-index">#{index + 1}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="form-wrap">
                  {isLoading || !buildTargetEditorSchema ? (
                    <p className="placeholder">Loading build target schema...</p>
                  ) : !selectedBuildTarget ? (
                    <p className="placeholder">No build targets in this domain yet. Add one to start editing.</p>
                  ) : (
                    <>
                      <p className="selected-group-title">
                        Editing Build Target: {selectedBuildTarget.name || 'Unnamed'}
                      </p>
                      <JsonForms
                        schema={buildTargetEditorSchema}
                        uischema={buildTargetEditorUiSchema || undefined}
                        data={selectedBuildTarget}
                        config={jsonFormsConfig}
                        renderers={renderers}
                        cells={materialCells}
                        onChange={({ data: updatedTarget }) => handleBuildTargetChange(updatedTarget)}
                      />
                    </>
                  )}
                </div>
              </section>
            )}
        </div>

        <div className="actions">
          <label className="commit-inline">
            <span>Change log entry</span>
            <input
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="What did you change?"
            />
          </label>

          <button
            type="button"
            onMouseDown={(event) => {
              // Keep focus on active field to avoid losing the click during blur-triggered rerenders.
              event.preventDefault();
            }}
            onClick={handleSave}
            disabled={saveDisabled || status.type === 'loading' || isLoading}
          >
            {status.type === 'loading' ? 'Saving...' : 'Save to GitHub'}
          </button>

          {status.type !== 'idle' ? <span className={`status ${status.type}`}>{status.text}</span> : null}
        </div>

        <p className="schema-hint">
          Active schemas: groups.schema.json, group-vars.schema.json, and build_targets.schema.json
        </p>

        {validationErrors.length > 0 ? (
          <ul className="validation-list">
            {validationErrors.map((error, index) => (
              <li key={`${error.instancePath}-${index}`}>
                {error.instancePath || '/'}: {error.message}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </main>
  );
}

export default App;
