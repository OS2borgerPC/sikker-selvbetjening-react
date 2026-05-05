export const schema = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      minLength: 1,
    },
    enabled: {
      type: 'boolean',
      default: true,
    },
    version: {
      type: 'integer',
      minimum: 1,
    },
    ownerEmail: {
      type: 'string',
      format: 'email',
    },
    tags: {
      type: 'array',
      items: {
        type: 'string',
      },
    },
    metadata: {
      type: 'object',
      properties: {
        sourceSystem: {
          type: 'string',
        },
        notes: {
          type: 'string',
        },
      },
      required: ['sourceSystem'],
    },
  },
  required: ['title', 'version', 'ownerEmail'],
};

export const uischema = {
  type: 'VerticalLayout',
  elements: [
    {
      type: 'Control',
      label: 'Title',
      scope: '#/properties/title',
    },
    {
      type: 'Control',
      label: 'Enabled',
      scope: '#/properties/enabled',
    },
    {
      type: 'Control',
      label: 'Version',
      scope: '#/properties/version',
    },
    {
      type: 'Control',
      label: 'Owner Email',
      scope: '#/properties/ownerEmail',
    },
    {
      type: 'Control',
      label: 'Tags',
      scope: '#/properties/tags',
    },
    {
      type: 'Group',
      label: 'Metadata',
      elements: [
        {
          type: 'Control',
          label: 'Source System',
          scope: '#/properties/metadata/properties/sourceSystem',
        },
        {
          type: 'Control',
          label: 'Notes',
          scope: '#/properties/metadata/properties/notes',
          options: {
            multi: true,
          },
        },
      ],
    },
  ],
};

export const initialData = {
  title: 'Example Configuration',
  enabled: true,
  version: 1,
  ownerEmail: 'owner@example.com',
  tags: ['self-service', 'config'],
  metadata: {
    sourceSystem: 'manual',
    notes: 'Initial data rendered by JSON Forms.',
  },
};
