// The composer's three menus as pure data: what `+`, `@` and `/` list for a given context and
// query, and how the active row moves. The component renders the groups and calls `action`.

import type {
  ComposerContext,
  ContextChip,
  MenuTeammate,
  TargetTask,
} from '../../../shared/composer.js';
import type { Appearance } from '../../../shared/contract.js';

type Command = 'task' | 'plan' | 'revise' | 'answer' | 'ask';

export type MenuAction =
  | { readonly kind: 'attach-file' }
  | { readonly kind: 'create-task' }
  | { readonly kind: 'ask-plan' }
  | { readonly kind: 'add-source' }
  | { readonly kind: 'chip'; readonly chip: ContextChip }
  | { readonly kind: 'command'; readonly command: Command };

export type MenuItem = {
  readonly id: string;
  readonly label: string;
  readonly hint: string | null;
  /** The reason the row cannot be picked, shown in place of the hint. */
  readonly disabled: string | null;
  readonly action: MenuAction;
  readonly avatar: {
    readonly id: string;
    readonly name: string;
    readonly appearance: Appearance;
  } | null;
};

export type MenuGroup = { readonly label: string; readonly items: readonly MenuItem[] };

export type MenuTrigger = {
  readonly kind: 'mention' | 'command';
  /** Index of the `@` or `/` in the text. */
  readonly anchor: number;
  readonly query: string;
};

/**
 * `@` opens at a word boundary (text start or after whitespace); `/` only at a line start. The
 * query is what follows up to the caret and closes the menu as soon as it holds whitespace.
 */
export function menuTrigger(text: string, caret: number): MenuTrigger | null {
  const before = text.slice(0, caret);
  const at = /(^|\s)([@/])([^\s@/]*)$/.exec(before);
  if (at === null) return null;
  const anchor = caret - at[2].length - at[3].length;
  if (at[2] === '/' && anchor !== 0 && text[anchor - 1] !== '\n') return null;
  return { kind: at[2] === '@' ? 'mention' : 'command', anchor, query: at[3] };
}

const matches = (query: string, ...fields: readonly string[]): boolean => {
  const needle = query.trim().toLowerCase();
  return needle === '' || fields.some((field) => field.toLowerCase().includes(needle));
};

const item = (
  id: string,
  label: string,
  action: MenuAction,
  extra: Partial<Pick<MenuItem, 'hint' | 'disabled' | 'avatar'>> = {},
): MenuItem => ({
  id,
  label,
  hint: extra.hint ?? null,
  disabled: extra.disabled ?? null,
  action,
  avatar: extra.avatar ?? null,
});

export function plusGroups(input: { readonly readOnly: boolean }): readonly MenuGroup[] {
  const off = input.readOnly ? 'Read-only in this segment' : null;
  return [
    {
      label: 'Add',
      items: [
        item(
          'plus:file',
          'Attach a file',
          { kind: 'attach-file' },
          {
            hint: '.txt, .md, .csv or .json, up to 200 KB',
            disabled: off,
          },
        ),
        item(
          'plus:source',
          'Add source',
          { kind: 'add-source' },
          {
            hint: 'Type @ to pick a source or teammate',
            disabled: off,
          },
        ),
      ],
    },
    {
      label: 'Work',
      items: [
        item(
          'plus:task',
          'Create task',
          { kind: 'create-task' },
          {
            hint: 'Review scope, specialists and sources before it starts',
            disabled: off,
          },
        ),
        item(
          'plus:plan',
          'Ask the coordinator for a plan',
          { kind: 'ask-plan' },
          {
            hint: 'You approve the plan before anything runs',
            disabled: off,
          },
        ),
      ],
    },
  ];
}

const teammateItem = (row: MenuTeammate): MenuItem =>
  item(
    `teammate:${row.id}`,
    row.name,
    { kind: 'chip', chip: { kind: 'teammate', id: row.id, name: row.name, role: row.role } },
    {
      hint: row.role,
      avatar: { id: row.id, name: row.name, appearance: row.appearance },
    },
  );

/** `@`: teammates of this segment the member may address, then the sources it allows. */
export function mentionGroups(
  context: ComposerContext | null,
  query: string,
  chips: readonly ContextChip[],
): readonly MenuGroup[] {
  if (context === null) return [];
  const chosen = new Set(
    chips.map((chip) =>
      chip.kind === 'teammate' ? chip.id : chip.kind === 'source' ? chip.source : '',
    ),
  );
  const teammates = context.teammates
    .filter((row) => !chosen.has(row.id) && matches(query, row.name, row.role))
    .map(teammateItem);
  const sources = context.sources
    .filter((source) => !chosen.has(source.kind) && matches(query, source.name))
    .map((source) =>
      item(
        `source:${source.kind}`,
        source.name,
        { kind: 'chip', chip: { kind: 'source', source: source.kind, name: source.name } },
        { disabled: source.unavailable },
      ),
    );
  return [
    { label: 'Teammates', items: teammates },
    { label: 'Sources', items: sources },
  ];
}

export type CommandFacts = {
  readonly currentTeammateId: string | null;
  readonly targets: readonly TargetTask[];
};

const COMMANDS: readonly {
  readonly command: Command;
  readonly label: string;
  readonly hint: string;
  readonly when: (facts: CommandFacts) => boolean;
}[] = [
  {
    command: 'task',
    label: '/task',
    hint: 'Turn this message into a task draft',
    when: () => true,
  },
  {
    command: 'plan',
    label: '/plan',
    hint: 'Ask the coordinator for a reviewed plan',
    when: () => true,
  },
  {
    command: 'revise',
    label: '/revise',
    hint: 'Request a revision of the latest result',
    when: (facts) => facts.targets.some((task) => task.latestRevision > 0),
  },
  {
    command: 'answer',
    label: '/answer',
    hint: "Answer a specialist's open question",
    when: (facts) => facts.targets.some((task) => task.openQuestions.length > 0),
  },
  {
    command: 'ask',
    label: '/ask',
    hint: 'Ask about a result of the active task',
    when: (facts) => facts.targets.length > 0,
  },
];

/** `/`: skills attached to the current teammate, then the commands that have a target right now. */
export function commandGroups(
  context: ComposerContext | null,
  query: string,
  facts: CommandFacts,
  chips: readonly ContextChip[],
): readonly MenuGroup[] {
  const chosen = new Set(chips.flatMap((chip) => (chip.kind === 'skill' ? [chip.id] : [])));
  const skills =
    context === null
      ? []
      : context.skills
          .filter(
            (skill) =>
              !chosen.has(skill.id) &&
              (facts.currentTeammateId === null ||
                skill.attachedTo.includes(facts.currentTeammateId)) &&
              matches(query, skill.name),
          )
          .map((skill) =>
            item(
              `skill:${skill.id}`,
              skill.name,
              { kind: 'chip', chip: { kind: 'skill', id: skill.id, name: skill.name } },
              { hint: skill.summary },
            ),
          );
  const commands = COMMANDS.filter((c) => c.when(facts) && matches(query, c.command)).map((c) =>
    item(
      `command:${c.command}`,
      c.label,
      { kind: 'command', command: c.command },
      { hint: c.hint },
    ),
  );
  return [
    { label: 'Skills', items: skills },
    { label: 'Commands', items: commands },
  ];
}

export const flatten = (groups: readonly MenuGroup[]): readonly MenuItem[] =>
  groups.flatMap((group) => group.items);

export const EMPTY_TEXT = {
  plus: 'Nothing to add here.',
  mention: 'No teammates or sources match.',
  command: 'No skills or commands match.',
} as const;

/** Arrow keys wrap; Home/End jump. Disabled rows stay reachable so their reason can be read. */
export function moveActive(count: number, active: number, key: string): number {
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return active < 0 ? 0 : (active + 1) % count;
    case 'ArrowUp':
      return active <= 0 ? count - 1 : active - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return active;
  }
}

/** The text after a pick: the `@query` or `/query` run is removed; the chip carries the meaning. */
export function removeTrigger(
  text: string,
  trigger: MenuTrigger,
): { readonly text: string; readonly caret: number } {
  const end = trigger.anchor + 1 + trigger.query.length;
  return { text: text.slice(0, trigger.anchor) + text.slice(end), caret: trigger.anchor };
}
