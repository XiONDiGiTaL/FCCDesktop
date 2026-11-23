/**
 * The skill taxonomy shown in discovery.
 *
 * This is a starting library, not a closed list: categories are plain data, the
 * UI renders whatever is here, and a skill may carry any category string — an
 * unknown one is displayed as-is instead of being rejected.
 */
import type { SkillCategory } from '../../src/shared/skills'

interface GroupDefinition {
  group: string
  items: Array<[id: string, label: string, keywords: string]>
}

const GROUPS: GroupDefinition[] = [
  {
    group: 'Programming and Software Engineering',
    items: [
      ['prog.general', 'General programming', 'programming language syntax algorithm data structure library api'],
      ['prog.python', 'Python', 'python pip poetry django flask pandas numpy asyncio'],
      ['prog.cpp', 'C and C++', 'c cpp c++ cmake clang gcc pointers templates memory'],
      ['prog.dotnet', 'C# and .NET', 'csharp c# dotnet .net asp.net nuget wpf winforms blazor'],
      ['prog.rust', 'Rust', 'rust cargo crate borrow lifetime tokio'],
      ['prog.java', 'Java', 'java jvm spring maven gradle kotlin'],
      ['prog.web-langs', 'JavaScript and TypeScript', 'javascript typescript node npm bun deno esm'],
      ['prog.debugging', 'Debugging', 'debug debugging stacktrace breakpoint reproduce bisect log'],
      ['prog.refactoring', 'Refactoring', 'refactor refactoring cleanup dead code simplify extract rename'],
      ['prog.review', 'Code review', 'code review pull request pr diff feedback review'],
      ['prog.architecture', 'Architecture', 'architecture system design boundaries module coupling layer domain modeling'],
      ['prog.performance', 'Performance optimization', 'performance optimization profiler latency throughput benchmark cache memory'],
      ['prog.testing', 'Testing and QA', 'test testing tdd unit integration e2e qa coverage playwright vitest'],
      ['prog.cross-platform', 'Cross-platform development', 'cross-platform portable platform windows linux macos port'],
    ],
  },
  {
    group: 'Web Development',
    items: [
      ['web.frontend', 'Frontend development', 'frontend html css javascript browser dom component'],
      ['web.backend', 'Backend development', 'backend server endpoint http rest api route middleware'],
      ['web.fullstack', 'Full-stack development', 'fullstack full-stack saas crud auth database frontend backend'],
      ['web.react', 'React', 'react jsx tsx hooks component state props'],
      ['web.nextjs', 'Next.js', 'next.js nextjs app router server component ssr vercel'],
      ['web.vue', 'Vue', 'vue nuxt composition api sfc'],
      ['web.angular', 'Angular', 'angular rxjs component service typescript'],
      ['web.api', 'API development', 'api rest graphql openapi swagger endpoint schema'],
      ['web.database', 'Database architecture', 'database schema sql postgres sqlite migration index orm query'],
      ['web.auth', 'Authentication', 'authentication auth oauth jwt session login signup permissions'],
      ['web.deployment', 'Deployment', 'deploy deployment docker ci cd pipeline hosting cloud environment'],
      ['web.security', 'Security', 'security xss csrf injection sanitize csp vulnerability secrets'],
    ],
  },
  {
    group: 'Web Design and UI/UX',
    items: [
      ['design.website', 'Website design', 'website design layout landing hero section page'],
      ['design.landing', 'Landing page generation', 'landing page marketing hero cta conversion above the fold'],
      ['design.ui', 'Modern UI design', 'ui interface visual design polish modern clean aesthetic'],
      ['design.responsive', 'Responsive design', 'responsive breakpoint mobile tablet fluid grid clamp container query'],
      ['design.a11y', 'Accessibility', 'accessibility a11y aria screen reader contrast keyboard focus wcag'],
      ['design.systems', 'Design systems', 'design system tokens spacing typography palette component library theme'],
      ['design.typography', 'Typography', 'typography font typeface hierarchy leading tracking scale'],
      ['design.components', 'Component libraries', 'component library shadcn radix tailwind variant styling'],
      ['design.ux-research', 'UX research', 'ux research user interview usability persona journey'],
      ['design.wireframe', 'Wireframing', 'wireframe sketch low fidelity layout flow'],
      ['design.prototype', 'Prototyping', 'prototype interactive mockup figma clickable'],
      ['design.redesign', 'Website redesign', 'redesign refresh modernise revamp existing site improve'],
    ],
  },
  {
    group: 'Application Development',
    items: [
      ['app.windows', 'Windows desktop applications', 'windows win32 winui wpf desktop application installer'],
      ['app.linux', 'Linux desktop applications', 'linux gtk qt flatpak deb appimage desktop'],
      ['app.cross-platform', 'Cross-platform applications', 'cross-platform desktop windows linux macos shared codebase'],
      ['app.electron', 'Electron', 'electron chromium node ipc main renderer preload'],
      ['app.tauri', 'Tauri', 'tauri rust webview native desktop'],
      ['app.dotnet-desktop', '.NET desktop development', 'wpf winforms maui avalonia dotnet desktop xaml'],
      ['app.qt', 'Qt', 'qt qml widgets cmake desktop c++'],
      ['app.gui-arch', 'GUI architecture', 'gui architecture window state panel layout event loop'],
      ['app.packaging', 'Packaging and installers', 'packaging installer setup nsis msi dmg appimage code signing'],
      ['app.porting', 'Porting Windows applications to Linux', 'port porting windows to linux wine electron migrate compatibility'],
    ],
  },
  {
    group: 'Game Development',
    items: [
      ['game.architecture', 'Game architecture', 'game architecture loop entity component scene state machine'],
      ['game.unity', 'Unity', 'unity c# shader prefab monobehaviour'],
      ['game.unreal', 'Unreal Engine', 'unreal ue5 blueprint c++ nanite lumen'],
      ['game.godot', 'Godot', 'godot gdscript scene node signal'],
      ['game.mechanics', 'Game mechanics', 'gameplay mechanic balancing combat movement progression'],
      ['game.physics', 'Physics', 'physics rigidbody collision raycast gravity simulation'],
      ['game.ai', 'AI and NPC systems', 'npc ai pathfinding behaviour tree state machine enemy'],
      ['game.multiplayer', 'Multiplayer development', 'multiplayer netcode replication server client lobby matchmaking'],
      ['game.optimization', 'Optimization', 'frame rate draw call lod batching profiling game optimization'],
      ['game.assets', 'Asset pipelines', 'asset pipeline import texture atlas build game assets'],
      ['game.ui', 'Game UI', 'hud game ui inventory menu overlay'],
    ],
  },
  {
    group: '2D Art and Game Assets',
    items: [
      ['art.pixel', 'Pixel art', 'pixel art pixelart sprite low resolution palette'],
      ['art.sprite', '2D sprite generation', 'sprite sprite sheet character sprite 2d game art'],
      ['art.sheets', 'Sprite sheets', 'sprite sheet atlas animation frames packed'],
      ['art.character', 'Character design', 'character design concept silhouette turnaround'],
      ['art.animation', 'Character animation', 'animation walk cycle idle run frames keyframe character'],
      ['art.tilesets', 'Tilesets', 'tileset tilemap tiles terrain autotile'],
      ['art.environment', 'Environmental assets', 'environment background parallax scenery level art'],
      ['art.texture', 'Texture generation', 'texture material seamless pattern noise'],
      ['art.frames', 'Animation frames', 'animation frames sequence timing loop'],
      ['art.pipeline', 'Game asset pipelines', 'asset pipeline export workflow game art integration'],
    ],
  },
  {
    group: 'Creative and Design Tools',
    items: [
      ['creative.html-css', 'HTML/CSS design', 'html css design page layout styling animation'],
      ['creative.svg', 'SVG generation', 'svg vector path illustration icon diagram'],
      ['creative.icon', 'Icon design', 'icon iconset glyph symbol stroke'],
      ['creative.logo', 'Logo design', 'logo mark brand identity wordmark'],
      ['creative.graphic', 'Graphic design', 'graphic design poster banner composition colour'],
      ['creative.image', 'Image composition', 'image composition photo collage mockup overlay'],
      ['creative.design-to-code', 'Design-to-code workflows', 'design to code implementation pixel perfect handoff figma'],
    ],
  },
]

export const SKILL_CATEGORIES: SkillCategory[] = GROUPS.flatMap((group) =>
  group.items.map(([id, label, keywords]) => ({
    id,
    label,
    group: group.group,
    keywords: keywords.split(' ').filter(Boolean),
  })),
)

const BY_ID = new Map(SKILL_CATEGORIES.map((category) => [category.id, category]))

export function categoryById(id: string | null | undefined): SkillCategory | null {
  if (!id) return null
  return BY_ID.get(id) ?? null
}

export function categoryLabel(id: string | null | undefined): string | null {
  if (!id) return null
  return BY_ID.get(id)?.label ?? id
}

/** Categories that mention a term, most specific first. */
export function categoriesFor(term: string): SkillCategory[] {
  const query = term.toLowerCase()
  return SKILL_CATEGORIES.filter(
    (category) => category.id.includes(query) || category.label.toLowerCase().includes(query),
  )
}

/** A free-form query from the discovery box turned into category keywords. */
export function keywordsForCategories(ids: string[]): string[] {
  const words = new Set<string>()
  for (const id of ids) {
    const category = BY_ID.get(id)
    if (!category) continue
    for (const keyword of category.keywords) words.add(keyword)
  }
  return Array.from(words)
}
