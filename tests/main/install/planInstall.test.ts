import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { planDeploy, planInstall, UnsafeEntryError } from '../../../src/main/install/planInstall'
import type { InstallRule } from '../../../src/shared/types'

const eco = JSON.parse(
  readFileSync(path.join(__dirname, '../../fixtures/ecosystem-min.json'), 'utf8')
)
const rules: InstallRule[] = eco.games.repo.r2modman[0].installRules
const packageId = 'Author-Mod'

const plan = (entries: string[]): ReturnType<typeof planInstall>['files'] =>
  planInstall(entries, { packageId, rules }).files

describe('planInstall', () => {
  test('root files go to default plugins subdir', () => {
    expect(plan(['manifest.json', 'icon.png', 'README.md', 'Mod.dll'])).toEqual([
      { from: 'manifest.json', to: 'BepInEx/plugins/Author-Mod/manifest.json', disableable: true },
      { from: 'icon.png', to: 'BepInEx/plugins/Author-Mod/icon.png', disableable: true },
      { from: 'README.md', to: 'BepInEx/plugins/Author-Mod/README.md', disableable: true },
      { from: 'Mod.dll', to: 'BepInEx/plugins/Author-Mod/Mod.dll', disableable: true }
    ])
  })

  test('routes plugins/patchers/config folders', () => {
    expect(plan(['plugins/A.dll', 'patchers/P.dll', 'config/a.cfg'])).toEqual([
      { from: 'plugins/A.dll', to: 'BepInEx/plugins/Author-Mod/A.dll', disableable: true },
      { from: 'patchers/P.dll', to: 'BepInEx/patchers/Author-Mod/P.dll', disableable: true },
      { from: 'config/a.cfg', to: 'BepInEx/config/a.cfg', disableable: false }
    ])
  })

  test('handles BepInEx/ prefix', () => {
    expect(plan(['BepInEx/plugins/A.dll', 'icon.png'])[0].to).toBe(
      'BepInEx/plugins/Author-Mod/A.dll'
    )
  })

  test('mm.dll goes to monomod', () => {
    expect(plan(['X.mm.dll'])).toEqual([
      { from: 'X.mm.dll', to: 'BepInEx/monomod/Author-Mod/X.mm.dll', disableable: true }
    ])
  })

  test('strips single wrapper folder', () => {
    expect(plan(['MyMod-1.2.0/manifest.json', 'MyMod-1.2.0/Mod.dll'])).toEqual([
      {
        from: 'MyMod-1.2.0/manifest.json',
        to: 'BepInEx/plugins/Author-Mod/manifest.json',
        disableable: true
      },
      { from: 'MyMod-1.2.0/Mod.dll', to: 'BepInEx/plugins/Author-Mod/Mod.dll', disableable: true }
    ])
  })

  test('does not strip route folder', () => {
    expect(plan(['config/a.cfg', 'config/b.cfg']).map((f) => f.to)).toEqual([
      'BepInEx/config/a.cfg',
      'BepInEx/config/b.cfg'
    ])
    expect(plan(['BepInEx/config/x.cfg']).map((f) => f.to)).toEqual(['BepInEx/config/x.cfg'])
  })

  test('does not strip when a root-level file exists', () => {
    expect(plan(['Wrap/a.txt', 'b.txt']).map((f) => f.to)).toEqual([
      'BepInEx/plugins/Author-Mod/Wrap/a.txt',
      'BepInEx/plugins/Author-Mod/b.txt'
    ])
  })

  test('unknown folders land under default route', () => {
    expect(plan(['assets/a.png', 'assets/b.png', 'x.dll']).map((f) => f.to)).toEqual([
      'BepInEx/plugins/Author-Mod/assets/a.png',
      'BepInEx/plugins/Author-Mod/assets/b.png',
      'BepInEx/plugins/Author-Mod/x.dll'
    ])
  })

  test('non-subdir tracking methods do not add the package folder', () => {
    const r: InstallRule[] = [
      {
        route: 'Game/state',
        defaultFileExtensions: [],
        trackingMethod: 'state',
        subRoutes: [],
        isDefaultLocation: true
      },
      {
        route: 'Game/pz',
        defaultFileExtensions: ['.pz'],
        trackingMethod: 'package-zip',
        subRoutes: [],
        isDefaultLocation: false
      }
    ]
    const out = planInstall(['a.pz', 'b.txt', 'state/c.txt'], { packageId, rules: r }).files
    expect(out.map((f) => f.to)).toEqual(['Game/pz/a.pz', 'Game/state/b.txt', 'Game/state/c.txt'])
    expect(out.every((f) => f.disableable)).toBe(true)
  })

  test('loader package', () => {
    const out = planInstall(
      ['BepInExPack/winhttp.dll', 'BepInExPack/BepInEx/core/BepInEx.Preloader.dll', 'icon.png'],
      {
        packageId,
        rules,
        loaderPackage: {
          packageId: 'BepInEx-BepInExPack',
          rootFolder: 'BepInExPack',
          loader: 'bepinex'
        }
      }
    ).files
    expect(out).toEqual([
      { from: 'BepInExPack/winhttp.dll', to: 'winhttp.dll', disableable: false },
      {
        from: 'BepInExPack/BepInEx/core/BepInEx.Preloader.dll',
        to: 'BepInEx/core/BepInEx.Preloader.dll',
        disableable: false
      }
    ])
  })

  test('a loader package with an empty root folder keeps paths as they are', () => {
    const out = planInstall(['winhttp.dll', 'BepInEx/core/BepInEx.Preloader.dll'], {
      packageId,
      rules,
      loaderPackage: { packageId: 'BepInEx-BepInExPack', rootFolder: '', loader: 'bepinex' }
    }).files
    expect(out).toEqual([
      { from: 'winhttp.dll', to: 'winhttp.dll', disableable: false },
      {
        from: 'BepInEx/core/BepInEx.Preloader.dll',
        to: 'BepInEx/core/BepInEx.Preloader.dll',
        disableable: false
      }
    ])
  })

  test('an empty root folder skips root-level package metadata files only', () => {
    const out = planInstall(
      [
        'manifest.json',
        'ICON.png',
        'README.md',
        'CHANGELOG.md',
        'changelog',
        'winhttp.dll',
        'BepInEx/core/README.md',
        'BepInEx/core/manifest.json'
      ],
      {
        packageId,
        rules,
        loaderPackage: {
          packageId: 'bbepis-BepInEx_Rogue_Tower',
          rootFolder: '',
          loader: 'bepinex'
        }
      }
    ).files
    expect(out.map((f) => f.to)).toEqual([
      'winhttp.dll',
      'BepInEx/core/README.md',
      'BepInEx/core/manifest.json'
    ])
  })

  test('rejects path traversal', () => {
    for (const e of ['../evil.dll', '/abs.dll', 'C:/x.dll', 'a/../../b.dll', 'a\\..\\b.dll']) {
      expect(() => plan([e])).toThrow(UnsafeEntryError)
    }
  })

  test('throws when there is no default rule', () => {
    expect(() =>
      planInstall(['a.txt'], {
        packageId,
        rules: rules.map((r) => ({ ...r, isDefaultLocation: false }))
      })
    ).toThrow(/default/)
  })

  test('rejects entries with no path segments', () => {
    for (const e of ['', '.', './', '//']) {
      expect(() => plan([e])).toThrow(UnsafeEntryError)
    }
  })

  test('rejects drive and UNC variants', () => {
    for (const e of ['C:\\x.dll', '\\\\srv\\x.dll', 'C:x.dll']) {
      expect(() => plan([e])).toThrow(UnsafeEntryError)
    }
  })

  test('rejects Windows-unsafe entry names', () => {
    const bad = [
      'a:b.dll',
      'dir/file:stream.dll',
      'con',
      'CON.txt',
      'plugins/nul.dll',
      'Aux.tar.gz',
      'prn',
      'com1.dll',
      'LPT9',
      'a./b.dll',
      'trailing.',
      'dir/trailing ',
      ' lead/x.dll/ '
    ]
    for (const e of bad) {
      expect(() => plan([e]), e).toThrow(UnsafeEntryError)
      expect(() => planDeploy([e]), e).toThrow(UnsafeEntryError)
    }
    for (const e of ['console.dll', 'com10.dll', 'conf/nulled.dll', 'comx', 'a.b/c.dll']) {
      expect(() => plan([e]), e).not.toThrow()
    }
  })

  test('loader rootFolder match is case-insensitive', () => {
    const out = planInstall(['bepinexpack/winhttp.dll'], {
      packageId,
      rules,
      loaderPackage: {
        packageId: 'BepInEx-BepInExPack',
        rootFolder: 'BepInExPack',
        loader: 'bepinex'
      }
    }).files
    expect(out).toEqual([
      { from: 'bepinexpack/winhttp.dll', to: 'winhttp.dll', disableable: false }
    ])
  })

  test('matches folders and extensions case-insensitively', () => {
    expect(plan(['Plugins/A.dll'])[0].to).toBe('BepInEx/plugins/Author-Mod/A.dll')
    expect(plan(['BEPINEX/plugins/A.dll', 'icon.png'])[0].to).toBe(
      'BepInEx/plugins/Author-Mod/A.dll'
    )
    expect(plan(['X.MM.DLL'])[0].to).toBe('BepInEx/monomod/Author-Mod/X.MM.DLL')
  })

  test('strips repeated wrapper folders', () => {
    expect(plan(['A/B/manifest.json', 'A/B/Mod.dll']).map((f) => f.to)).toEqual([
      'BepInEx/plugins/Author-Mod/manifest.json',
      'BepInEx/plugins/Author-Mod/Mod.dll'
    ])
  })

  test('loader package wrapped in an outer folder', () => {
    const out = planInstall(['Pack-5.4/BepInExPack/winhttp.dll', 'Pack-5.4/icon.png'], {
      packageId,
      rules,
      loaderPackage: {
        packageId: 'BepInEx-BepInExPack',
        rootFolder: 'BepInExPack',
        loader: 'bepinex'
      }
    }).files
    expect(out).toEqual([
      { from: 'Pack-5.4/BepInExPack/winhttp.dll', to: 'winhttp.dll', disableable: false }
    ])
  })

  describe('unreal_shimloader', () => {
    const shim = {
      packageId: 'Thunderstore-unreal_shimloader',
      rootFolder: '',
      loader: 'shimloader'
    }
    const SHIM_ZIP = [
      'dwmapi.dll',
      'icon.png',
      'manifest.json',
      'README.md',
      'UE4SS/',
      'UE4SS/dwmapi.dll',
      'UE4SS/LICENSE',
      'UE4SS/Mods/',
      'UE4SS/Mods/BPModLoaderMod/Scripts/main.lua',
      'UE4SS/Mods/mods.txt',
      'UE4SS/UE4SS-settings.ini',
      'UE4SS/UE4SS.dll'
    ]

    test('lays the shim and UE4SS out as r2modman does, UE4SS mods under shimloader/mod', () => {
      const out = planInstall(SHIM_ZIP, { packageId, rules, loaderPackage: shim }).files
      expect(out).toEqual([
        { from: 'dwmapi.dll', to: 'dwmapi.dll', disableable: false },
        {
          from: 'UE4SS/Mods/BPModLoaderMod/Scripts/main.lua',
          to: 'shimloader/mod/BPModLoaderMod/Scripts/main.lua',
          disableable: false
        },
        { from: 'UE4SS/Mods/mods.txt', to: 'shimloader/mod/mods.txt', disableable: false },
        { from: 'UE4SS/UE4SS-settings.ini', to: 'UE4SS-settings.ini', disableable: false },
        { from: 'UE4SS/UE4SS.dll', to: 'ue4ss.dll', disableable: false }
      ])
    })

    test('finds UE4SS in any case and inside a wrapper folder', () => {
      const out = planInstall(['pkg/dwmapi.dll', 'pkg/ue4ss/ue4ss.dll'], {
        packageId,
        rules,
        loaderPackage: shim
      }).files
      expect(out.map((f) => f.to)).toEqual(['dwmapi.dll', 'ue4ss.dll'])
    })

    test('a shimloader package without a UE4SS folder keeps its paths', () => {
      const out = planInstall(['dwmapi.dll', 'other/x.dll'], {
        packageId,
        rules,
        loaderPackage: shim
      }).files
      expect(out.map((f) => f.to)).toEqual(['dwmapi.dll', 'other/x.dll'])
    })
  })

  describe('MelonLoader', () => {
    const melon = { packageId: 'LavaGang-MelonLoader', rootFolder: '', loader: 'melonloader' }
    const recursive = (entries: string[]): ReturnType<typeof planInstall>['files'] =>
      planInstall(entries, { packageId, rules: [], loader: 'recursive-melonloader' }).files

    test('the loader package keeps its paths, without the package metadata', () => {
      const out = planInstall(
        [
          'manifest.json',
          'icon.png',
          'README.md',
          'version.dll',
          'MelonLoader/net6/MelonLoader.dll'
        ],
        {
          packageId: 'LavaGang-MelonLoader',
          rules: [],
          loaderPackage: melon,
          loader: 'recursive-melonloader'
        }
      ).files
      expect(out).toEqual([
        { from: 'version.dll', to: 'version.dll', disableable: false },
        {
          from: 'MelonLoader/net6/MelonLoader.dll',
          to: 'MelonLoader/net6/MelonLoader.dll',
          disableable: false
        }
      ])
    })

    test('v0.7+ mods go under Mods/<package>, their UserData under UserData/<package>', () => {
      expect(recursive(['manifest.json', 'Mods/A.dll', 'UserData/a.cfg', 'Plugins/P.dll'])).toEqual(
        [
          { from: 'manifest.json', to: 'Mods/Author-Mod/manifest.json', disableable: true },
          { from: 'Mods/A.dll', to: 'Mods/Author-Mod/Mods/A.dll', disableable: true },
          { from: 'UserData/a.cfg', to: 'UserData/Author-Mod/a.cfg', disableable: false },
          { from: 'Plugins/P.dll', to: 'Mods/Author-Mod/Plugins/P.dll', disableable: true }
        ]
      )
    })

    test('strips a wrapper folder but not a MelonLoader folder', () => {
      expect(recursive(['Release/A.dll', 'Release/B.dll']).map((f) => f.to)).toEqual([
        'Mods/Author-Mod/A.dll',
        'Mods/Author-Mod/B.dll'
      ])
      expect(recursive(['UserData/a.cfg', 'UserData/b.cfg']).map((f) => f.to)).toEqual([
        'UserData/Author-Mod/a.cfg',
        'UserData/Author-Mod/b.cfg'
      ])
    })

    test('older MelonLoader games follow their install rules', () => {
      const melonRules: InstallRule[] = [
        {
          route: 'Mods',
          defaultFileExtensions: ['.dll'],
          trackingMethod: 'state',
          subRoutes: [],
          isDefaultLocation: false
        },
        {
          route: 'UserData/ModManager',
          defaultFileExtensions: [],
          trackingMethod: 'subdir-no-flatten',
          subRoutes: [],
          isDefaultLocation: true
        },
        {
          route: 'UserLibs',
          defaultFileExtensions: ['.lib.dll'],
          trackingMethod: 'state',
          subRoutes: [],
          isDefaultLocation: false
        }
      ]
      const out = planInstall(['A.dll', 'X.lib.dll', 'notes.txt'], {
        packageId,
        rules: melonRules,
        loader: 'melonloader'
      }).files
      expect(out.map((f) => f.to)).toEqual([
        'Mods/A.dll',
        'UserLibs/X.lib.dll',
        'UserData/ModManager/Author-Mod/notes.txt'
      ])
    })
  })

  describe('lovely', () => {
    test('the loader puts its DLL at the root and its lovely folder under mods', () => {
      const out = planInstall(
        ['manifest.json', 'icon.png', 'README.md', 'winmm.dll', 'lovely/', 'lovely/config.toml'],
        {
          packageId: 'Thunderstore-lovely',
          rules: [],
          loaderPackage: { packageId: 'Thunderstore-lovely', rootFolder: '', loader: 'lovely' },
          loader: 'lovely'
        }
      ).files
      expect(out).toEqual([
        { from: 'winmm.dll', to: 'winmm.dll', disableable: false },
        { from: 'lovely/config.toml', to: 'mods/lovely/config.toml', disableable: false }
      ])
    })

    test('mods go under mods/<package>, keeping their paths', () => {
      const out = planInstall(['manifest.json', 'lovely.toml', 'lib/nativefs.lua'], {
        packageId,
        rules: [],
        loader: 'lovely'
      }).files
      expect(out).toEqual([
        { from: 'manifest.json', to: 'mods/Author-Mod/manifest.json', disableable: true },
        { from: 'lovely.toml', to: 'mods/Author-Mod/lovely.toml', disableable: true },
        { from: 'lib/nativefs.lua', to: 'mods/Author-Mod/lib/nativefs.lua', disableable: true }
      ])
    })
  })

  describe('Return of Modding', () => {
    const rom = (entries: string[]): string[] =>
      planInstall(entries, { packageId, rules: [], loader: 'return-of-modding' }).files.map(
        (f) => f.to
      )

    test('the loader package puts its DLL at the profile root', () => {
      const out = planInstall(['manifest.json', 'ReturnOfModdingPack/d3d12.dll'], {
        packageId: 'Hell2Modding-Hell2Modding',
        rules: [],
        loaderPackage: {
          packageId: 'Hell2Modding-Hell2Modding',
          rootFolder: 'ReturnOfModdingPack',
          loader: 'return-of-modding'
        },
        loader: 'return-of-modding'
      }).files
      expect(out).toEqual([
        { from: 'ReturnOfModdingPack/d3d12.dll', to: 'd3d12.dll', disableable: false }
      ])
    })

    test('mods go under plugins/<package>, keeping their manifest', () => {
      expect(rom(['manifest.json', 'main.lua', 'src/util.lua'])).toEqual([
        'ReturnOfModding/plugins/Author-Mod/manifest.json',
        'ReturnOfModding/plugins/Author-Mod/main.lua',
        'ReturnOfModding/plugins/Author-Mod/src/util.lua'
      ])
    })

    test('plugins_data and config folders go to their own folders', () => {
      expect(rom(['main.lua', 'plugins_data/a.png', 'config/x.cfg'])).toEqual([
        'ReturnOfModding/plugins/Author-Mod/main.lua',
        'ReturnOfModding/plugins_data/Author-Mod/a.png',
        'ReturnOfModding/config/Author-Mod/x.cfg'
      ])
      expect(rom(['ReturnOfModding/plugins/main.lua', 'ReturnOfModding/config/x.cfg'])).toEqual([
        'ReturnOfModding/plugins/Author-Mod/main.lua',
        'ReturnOfModding/config/Author-Mod/x.cfg'
      ])
    })
  })
})

describe('planDeploy', () => {
  const to = (e: string[]): string[] => planDeploy(e).files.map((f) => f.to)
  test('strips one sole wrapping folder', () => {
    expect(to(['Mod/Data/a.esp', 'Mod/readme.txt'])).toEqual(['Data/a.esp', 'readme.txt'])
  })
  test('keeps a normal layout and marks everything disableable', () => {
    const plan = planDeploy(['Data/a.esp', 'b.txt'])
    expect(plan.files.map((f) => f.to)).toEqual(['Data/a.esp', 'b.txt'])
    expect(plan.files.every((f) => f.disableable)).toBe(true)
  })
  test('keeps a lone game-layout folder', () => {
    expect(to(['Data/a.esp'])).toEqual(['Data/a.esp'])
    expect(to(['BepInEx/plugins/A.dll'])).toEqual(['BepInEx/plugins/A.dll'])
  })
  test('rejects unsafe entries', () => {
    expect(() => planDeploy(['../x'])).toThrow(UnsafeEntryError)
  })
  test('with a root, strips a sole top-level folder equal to it (case-insensitive)', () => {
    const toR = (e: string[]): string[] => planDeploy(e, { root: 'Data' }).files.map((f) => f.to)
    expect(toR(['Data/x.esp', 'Data/meshes/a.nif'])).toEqual(['x.esp', 'meshes/a.nif'])
    expect(toR(['data/x.esp'])).toEqual(['x.esp'])
    expect(toR(['Mod/Data/x.esp'])).toEqual(['x.esp'])
    expect(toR(['MyMod.esp', 'meshes/a.nif'])).toEqual(['MyMod.esp', 'meshes/a.nif'])
    expect(toR(['Data/x.esp', 'readme.txt'])).toEqual(['Data/x.esp', 'readme.txt'])
  })
  test('without a root a lone Data folder is kept', () => {
    expect(planDeploy(['Data/x.esp'], {}).files.map((f) => f.to)).toEqual(['Data/x.esp'])
  })
})
