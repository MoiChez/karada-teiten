# 筋肉の見える体の絵の作り方

`public/models/muscle-skin-v1-color.webp`（色）と `muscle-skin-v1-normal.webp`（凹凸）を作り直す手順。
アプリは絵を読むだけで、ここの道具とはつながない。

## 元のデータ

- Z-Anatomy（`Z-Anatomy.zip` の中の `Startup.blend`、CC BY-SA 4.0）: https://github.com/Z-Anatomy/The-blend
- 元のデータはリポジトリに入れない。できた 2 枚の絵だけを入れる（ライセンスは `public/models/muscle-skin-LICENSE.txt`）

## 手順（Blender 5.2 + MPFB 2、Python は numpy・scipy・Pillow）

`W` は作業用のフォルダ、`T` はこのフォルダ。`.blend` に入っているスクリプトは動かさない（`--disable-autoexec`）。

1. 筋肉・腱・骨・靱帯だけを取り出す: `blender -b --factory-startup --disable-autoexec Startup.blend --python T/zprep.py -- W`
2. アプリの体（MPFB の中間の体）を横に作り、両方の関節の位置を出す: `blender -b --disable-autoexec W/anat.blend --python T/zfit.py -- T W`
3. アプリの体を解剖モデルの姿勢・寸法に重ねる: `blender -b --factory-startup --disable-autoexec W/fit0.blend --python T/zpose.py -- T W T/fit.json norender`
   （`norender` を外すと、重なり具合の確認用の絵を描く）
4. 体の UV へ焼く（2048 px、約 50 分）: `blender -b --factory-startup --disable-autoexec W/fit1.blend --python T/zbake.py -- T W 2048`
5. 絵にまとめる: `python T/zcompose.py W/bake_2048.npz 出力先 2048 1024`

## 中身

- **重ね方**（zpose.py）: 胴は股関節と肩の高さで伸縮、腕・脚・指は関節から関節へ骨ごとに向きと長さを合わせる。
  解剖モデルは手のひらが前を向いているので、手のねじりをひじから手首へ少しずつ配る
- **焼き方**（zbake.py）: 体の表面から法線の向きに解剖モデルを探し、最初に当たった面の色・法線・陰（AO）を取る。
  腕が胴に、左右の脚が互いに当たらないよう、胴・腕・手・脚・足に分けて焼き、骨の重みで混ぜる
- **まとめ方**（zcompose.py）: 当たらなかった所と UV の島の外は、いちばん近い当たった所の値で埋める。陰は色に掛ける
