@echo off
rem ===== クラウド作業環境で作った git bundle を PC のリポジトリへ安全に取り込み、GitHub へ通常 push する =====
rem 使い方（リポジトリのフォルダで）:
rem   tools\handoff\integrate_bundle.bat <bundle のパス> [push]
rem   push を付けないと確認だけ（何も変更しない）。force push・reset・rebase はしない。
setlocal
chcp 65001 >nul
set BUNDLE=%~1
set BR=feature/cg-stage-auth
if "%BUNDLE%"=="" ( echo bundle のパスを指定してください & exit /b 1 )
echo [1] bundle の検査
git bundle verify "%BUNDLE%" || exit /b 1
echo [2] 作業ツリーの状態（未コミットの変更はこの手順では触りません）
git status --short
for /f %%i in ('git branch --show-current') do set CUR=%%i
echo 現在のブランチ: %CUR%
echo [3] 取得（ローカルのブランチ・作業ツリーは変えない）
git fetch origin %BR% || exit /b 1
git fetch "%BUNDLE%" %BR%:refs/remotes/bundle/%BR% || exit /b 1
echo [4] GitHub 側に bundle に無いコミットがないか
git merge-base --is-ancestor origin/%BR% bundle/%BR%
if errorlevel 1 (
  echo GitHub 側に新しいコミットがあります。push せずに止めます。統合する場合:
  echo   git switch -c integrate-bundle bundle/%BR%
  echo   git merge origin/%BR%     ^(衝突したら解決してコミット^)
  echo   git push origin integrate-bundle:%BR%
  exit /b 1
)
echo [5] PC のローカルブランチに bundle に無いコミットがないか
git rev-parse --verify --quiet %BR% >nul && (
  git merge-base --is-ancestor %BR% bundle/%BR% || (
    echo PC の %BR% に bundle に無いコミットがあります。取り込み前に統合してください:
    echo   git switch %BR% ^&^& git merge bundle/%BR%
    exit /b 1
  )
)
echo 取り込むコミット:
git log --oneline origin/%BR%..bundle/%BR%
if /i not "%~2"=="push" ( echo 確認のみで終了しました。push する場合は最後に push を付けて実行してください。 & exit /b 0 )
echo [6] 念のためのバックアップ用ブランチ
git branch -f backup/%BR%-before-bundle origin/%BR%
echo [7] GitHub へ通常 push（fast-forward のみ）
git push origin bundle/%BR%:refs/heads/%BR% || exit /b 1
echo [8] PC のローカルブランチを進める（作業ツリーがきれいで、そのブランチにいるときだけ）
if "%CUR%"=="%BR%" (
  git diff --quiet && git diff --cached --quiet && git merge --ff-only bundle/%BR% || echo 未コミットの変更があるため、ローカルブランチは進めていません。変更をコミットしてから git merge --ff-only bundle/%BR%
) else (
  git branch -f %BR% bundle/%BR% 2>nul || echo ローカルブランチは後で git switch %BR% ^&^& git merge --ff-only bundle/%BR%
)
echo 完了。公開サイトの更新は DEPLOY.md の手順（提供 ZIP から作った素材で build-dist → wrangler deploy）で別に行います。
