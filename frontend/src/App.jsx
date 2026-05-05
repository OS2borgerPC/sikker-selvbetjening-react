import { JsonForms } from '@jsonforms/react';
import { materialCells, materialRenderers } from '@jsonforms/material-renderers';
import { useEffect, useMemo, useState } from 'react';

const defaultPath = 'config/groups.yml';
const defaultData = {
  groups: [
    {
      name: 'new-group',
    },
  ],
};

const getGroups = (payload) => {
  if (payload && Array.isArray(payload.groups)) {
    return payload.groups;
  }

  return [];
};

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

const buildUniqueGroupName = (existingGroups, preferredName = 'new-group') => {
  const existingNames = new Set(existingGroups.map((group) => group?.name).filter(Boolean));
  const base = normalizeGroupName(preferredName);

  if (!existingNames.has(base)) {
    return base;
  }

  let suffix = 2;
  while (existingNames.has(`${base}-${suffix}`)) {
    suffix += 1;
  }

  return `${base}-${suffix}`;
};

const sanitizeGroup = (group) => {
  if (!group || typeof group !== 'object') {
    return group;
  }

  const nextGroup = { ...group };
  if (nextGroup.desktop && typeof nextGroup.desktop === 'object') {
    const desktop = { ...nextGroup.desktop };

    if (Array.isArray(desktop.shortcuts_in_menu)) {
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

const sanitizeGroupsPayload = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const groups = getGroups(payload).map((group) => sanitizeGroup(group));
  return {
    ...payload,
    groups,
  };
};

function App() {
  const [data, setData] = useState(defaultData);
  const path = defaultPath;
  const [groupsSchema, setGroupsSchema] = useState(null);
  const [groupVarsSchema, setGroupVarsSchema] = useState(null);
  const [message, setMessage] = useState('Update groups configuration via form');
  const [status, setStatus] = useState({ type: 'idle', text: '' });
  const [validationErrors, setValidationErrors] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedGroupIndex, setSelectedGroupIndex] = useState(0);

  const groups = useMemo(() => getGroups(data), [data]);
  const selectedGroup = groups[selectedGroupIndex] || null;
  const selectedGroupName = selectedGroup?.name || `Group ${selectedGroupIndex + 1}`;
  const groupItemSchema = groupsSchema?.properties?.groups?.items || null;
  const groupEditorSchema = useMemo(() => {
    if (!groupItemSchema) {
      return null;
    }

    return {
      $defs: groupsSchema?.$defs || {},
      ...groupItemSchema,
    };
  }, [groupItemSchema, groupsSchema]);
  const saveDisabled = useMemo(() => !path.trim() || groups.length === 0, [path, groups.length]);

  useEffect(() => {
    const controller = new AbortController();

    const loadInitialData = async () => {
      setIsLoading(true);
      setStatus({ type: 'loading', text: 'Loading schema and existing YAML...' });
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
        setGroupVarsSchema(schemasResult.groupVarsSchema);

        if (fileResponse.status === 404) {
          setData(defaultData);
          setStatus({ type: 'idle', text: 'groups.yml not found yet. Using a starter object.' });
          return;
        }

        const fileResult = await fileResponse.json();
        if (!fileResponse.ok) {
          throw new Error(fileResult.error || 'Failed to load config file');
        }

        setData(fileResult.parsed || defaultData);
        setSelectedGroupIndex(0);
        setStatus({ type: 'idle', text: 'Loaded config/groups.yml from GitHub.' });
      } catch (error) {
        if (error.name === 'AbortError') {
          return;
        }

        setStatus({
          type: 'error',
          text: error.message || 'Failed to load schema/config from GitHub.',
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
    if (groups.length === 0) {
      setSelectedGroupIndex(0);
      return;
    }

    if (selectedGroupIndex > groups.length - 1) {
      setSelectedGroupIndex(groups.length - 1);
    }
  }, [groups.length, selectedGroupIndex]);

  const handleGroupChange = (updatedGroup) => {
    setData((prev) => {
      const cleanedGroup = sanitizeGroup(updatedGroup);
      const nextGroups = getGroups(prev).map((group, index) =>
        index === selectedGroupIndex ? cleanedGroup : group
      );

      return {
        ...prev,
        groups: nextGroups,
      };
    });
  };

  const addGroup = () => {
    setData((prev) => {
      const currentGroups = getGroups(prev);
      const nextName = buildUniqueGroupName(currentGroups);
      const nextGroups = [...currentGroups, { name: nextName }];
      setSelectedGroupIndex(nextGroups.length - 1);

      return {
        ...prev,
        groups: nextGroups,
      };
    });
  };

  const duplicateGroup = () => {
    if (!selectedGroup) {
      return;
    }

    setData((prev) => {
      const currentGroups = getGroups(prev);
      const insertIndex = selectedGroupIndex + 1;
      const preferredName = `${selectedGroup.name || 'group'}-copy`;
      const clone = {
        ...selectedGroup,
        name: buildUniqueGroupName(currentGroups, preferredName),
      };
      const nextGroups = [
        ...currentGroups.slice(0, insertIndex),
        clone,
        ...currentGroups.slice(insertIndex),
      ];
      setSelectedGroupIndex(insertIndex);

      return {
        ...prev,
        groups: nextGroups,
      };
    });
  };

  const removeSelectedGroup = () => {
    if (!selectedGroup || groups.length === 0) {
      return;
    }

    setData((prev) => {
      const currentGroups = getGroups(prev);
      const nextGroups = currentGroups.filter((_, index) => index !== selectedGroupIndex);

      return {
        ...prev,
        groups: nextGroups,
      };
    });
  };

  const handleSave = async () => {
    setStatus({ type: 'loading', text: 'Saving to GitHub...' });
    setValidationErrors([]);
    const cleanedData = sanitizeGroupsPayload(data);
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
        <h1>Git-backed Groups YAML Editor</h1>
        <p>
          Edit config/groups.yml with JSON Forms and validate it against both groups schemas before
          saving to GitHub.
        </p>
      </section>

      <section className="panel">
        <div className="controls-grid">
          <label>
            Repository Path
            <input value={path} readOnly />
          </label>

          <label>
            Commit Message
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Update via form"
            />
          </label>
        </div>

        <div className="group-editor">
          <aside className="group-list-wrap">
            <div className="group-list-header">
              <h2>Groups</h2>
              <span>{groups.length}</span>
            </div>

            <div className="group-list-actions">
              <button type="button" className="secondary" onClick={addGroup} disabled={isLoading}>
                Add Group
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
              {groups.map((group, index) => {
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
          </aside>

          <div className="form-wrap">
            {isLoading || !groupEditorSchema ? (
              <p className="placeholder">Loading...</p>
            ) : !selectedGroup ? (
              <p className="placeholder">No groups yet. Add one to start editing.</p>
            ) : (
              <>
                <p className="selected-group-title">Editing: {selectedGroupName}</p>
                <JsonForms
                  schema={groupEditorSchema}
                  data={selectedGroup}
                  renderers={materialRenderers}
                  cells={materialCells}
                  onChange={({ data: updatedGroup }) => handleGroupChange(updatedGroup)}
                />
              </>
            )}
          </div>
        </div>

        <div className="actions">
          <button onClick={handleSave} disabled={saveDisabled || status.type === 'loading' || isLoading}>
            {status.type === 'loading' ? 'Saving...' : 'Save to GitHub'}
          </button>

          <span className={`status ${status.type}`}>{status.text}</span>
        </div>

        <p className="schema-hint">
          Active schemas: groups.schema.json and group-vars.schema.json
          {groupVarsSchema ? '' : ' (loading...)'}
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
