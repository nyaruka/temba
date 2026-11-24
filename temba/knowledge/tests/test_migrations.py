from datetime import timedelta

from django.utils import timezone

from temba.knowledge.models import Article, ArticleTally, KnowledgeSource
from temba.tests import MigrationTest


class BackfillArticleTalliesTest(MigrationTest):
    app = "knowledge"
    migrate_from = "0015_articletally"
    migrate_to = "0016_backfill_article_tallies"

    def setUpBeforeMigration(self, apps):
        ArticleCount = apps.get_model("knowledge", "ArticleCount")
        helpdesk = self.org.sources.get(source_type=KnowledgeSource.TYPE_HELPDESK)
        self.today = timezone.now().date()

        self.nodes = Article.create(helpdesk, self.admin, "Nodes")
        self.actions = Article.create(helpdesk, self.admin, "Actions")

        def count(article, days_ago: int, n: int, *, is_squashed=False):
            day = self.today - timedelta(days=days_ago)
            ArticleCount.objects.create(article_id=article.id, day=day, scope="views", count=n, is_squashed=is_squashed)

        count(self.nodes, 0, 3, is_squashed=True)
        count(self.nodes, 0, 1)
        count(self.nodes, 5, 2)
        count(self.actions, 90, 4)
        count(self.actions, 91, 7)  # past retention so not copied

        # already flushed from Valkey, so added to
        self.nodes.tallies.create(scope=f"views@{self.today}", count=2)

    def test_migration(self):
        def day(days_ago: int) -> str:
            return (self.today - timedelta(days=days_ago)).isoformat()

        def expires(days_ago: int):
            return self.today - timedelta(days=days_ago) + timedelta(days=90)

        self.assertEqual(
            [
                (self.nodes.id, f"views@{day(0)}", 6, expires(0)),
                (self.nodes.id, f"views@{day(5)}", 2, expires(5)),
                (self.actions.id, f"views@{day(90)}", 4, expires(90)),
            ],
            list(
                ArticleTally.objects.order_by("article_id", "-scope").values_list(
                    "article_id", "scope", "count", "expires_on"
                )
            ),
        )
